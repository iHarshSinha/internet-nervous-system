import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { OriginTable } from '../pipeline/origins.ts';
import { Detectors } from '../detect/detectors.ts';
import { fromAnomaly, fromHijack, fromLeak, fromOutage, fromPairs, RadarPoller } from './radar.ts';

// Real Cloudflare Radar responses recorded on 13 Nov 2026, trimmed (data: CC BY-NC 4.0).
const fx = JSON.parse(
  readFileSync(new URL('./fixtures/radar.json', import.meta.url), 'utf8'),
) as Record<string, unknown[]>;

describe('Cloudflare Radar normalisers', () => {
  it('turns outage annotations into events with countries and a one-line title', () => {
    const [ms365, ukraine] = fx.annotations!.map(fromOutage);
    expect(ms365).toMatchObject({ id: 'radar:outage:1749', type: 'outage', end: null });
    expect(ms365!.title).toMatch(/^A global Microsoft 365 disruption/);
    expect(ukraine).toMatchObject({ countries: ['UA'], start: Date.UTC(2026, 10, 8, 3, 15) });
    expect(ukraine!.end).toBe(Date.UTC(2026, 10, 8, 21, 0));
  });

  it('reads anomalies, hijacks and leaks, with times without a zone taken as UTC', () => {
    const anomaly = fromAnomaly(fx.trafficAnomalies![0]);
    expect(anomaly).toMatchObject({ type: 'anomaly', asns: [327712], countries: ['DZ'] });
    const hijack = fromHijack(fx.bgp_hijacks_events![0]);
    expect(hijack).toMatchObject({ type: 'hijack', asns: [269800], countries: ['HN'] });
    expect(hijack!.start).toBe(Date.parse('2026-11-13T19:03:03.679Z'));
    expect(hijack!.title).toMatch(/AS3561 announced 1 prefix of AS269800/);
    const leak = fromLeak(fx.bgp_leaks_events![0]);
    expect(leak).toMatchObject({ type: 'leak', asns: [39273], countries: ['BH', 'AE'], end: null });
  });

  it('keeps valid attack pairs and rejects broken records', () => {
    const pairs = fromPairs(fx.top_0, 'l7');
    expect(pairs[0]).toEqual({ from: 'CN', to: 'US', value: 9.35, layer: 'l7' });
    expect(
      fromPairs([{ originCountryAlpha2: 'X1', targetCountryAlpha2: 'US', value: 1 }], 'l3'),
    ).toEqual([]);
    expect(fromOutage({ id: 1 })).toBeNull();
    expect(fromHijack('nonsense')).toBeNull();
  });
});

describe('RadarPoller', () => {
  const reply = (result: unknown, ok = true) =>
    new Response(JSON.stringify({ success: ok, errors: [], result }), { status: 200 });

  it('polls each endpoint with the token, and hands over validated events and pairs', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token-0123456789');
      if (url.includes('annotations')) return reply({ annotations: fx.annotations });
      if (url.includes('traffic_anomalies'))
        return reply({ trafficAnomalies: fx.trafficAnomalies });
      if (url.includes('hijacks')) return reply({ events: fx.bgp_hijacks_events });
      if (url.includes('leaks')) return reply({ events: [...fx.bgp_leaks_events!, { bad: 1 }] });
      return reply({ top_0: fx.top_0 });
    }) as typeof fetch;
    const events: unknown[] = [];
    const pairs: unknown[] = [];
    const poller = new RadarPoller({
      token: 'test-token-0123456789',
      log: pino({ level: 'silent' }),
      eventsEveryMs: 60_000,
      pairsEveryMs: 900_000,
      onEvents: (e) => events.push(...e),
      onPairs: (p) => pairs.push(...p),
      fetchFn,
    });
    expect(await poller.pollEvents()).toBe(true);
    expect(await poller.pollPairs()).toBe(true);
    // The fixture's leaks were seen by 46, 1 and 8 peers: only the first is kept.
    expect(events).toHaveLength(2 + 3 + 3 + 1);
    expect(poller.stats.filtered).toBe(2);
    expect(poller.stats.rejected).toBe(1);
    expect(pairs).toHaveLength(6); // 3 layer 7 + 3 layer 3 (same fixture)
    expect(seen.every((u) => u.startsWith('https://api.cloudflare.com/client/v4/radar/'))).toBe(
      true,
    );
    expect(seen.every((u) => u.includes('format=json'))).toBe(true);
  });

  it('counts failures instead of throwing', async () => {
    const poller = new RadarPoller({
      token: 'test-token-0123456789',
      log: pino({ level: 'silent' }),
      eventsEveryMs: 60_000,
      pairsEveryMs: 900_000,
      onEvents: () => {},
      onPairs: () => {},
      fetchFn: (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch,
    });
    expect(await poller.pollEvents()).toBe(false);
    expect(poller.stats.errors).toBe(4);
    expect(poller.stats.lastError).toMatch(/HTTP 403/);
  });
});

describe('D6: Cloudflare confirmation', () => {
  it('signals for the network and country of a current Radar event, not for old ones', () => {
    const detectors = new Detectors({ origins: new OriginTable(), connectedProbes: () => 0 });
    const now = Date.UTC(2026, 10, 13, 19, 30);
    detectors.observeRadar([
      fromLeak(fx.bgp_leaks_events![0])!, // ongoing, AS39273, BH and AE
      { ...fromOutage(fx.annotations![1])! }, // Ukraine, ended 8 Nov: too old
    ]);
    const signals = detectors.evaluate(now).filter((s) => s.type === 'cloudflare');
    expect(signals.map((s) => s.scope)).toEqual(['asn:39273']); // a leak: the network only
    expect(signals[0]!.weight).toBe(0.3);
  });
});
