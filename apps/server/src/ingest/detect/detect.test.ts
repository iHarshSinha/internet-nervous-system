import { fileURLToPath } from 'node:url';
import type { EventEnvelope, Incident, Signal } from '@ins/shared';
import { describe, expect, it } from 'vitest';
import { facebookPlan } from '../../scenarios/facebook.ts';
import { OriginTable } from '../pipeline/origins.ts';
import { Pipeline } from '../pipeline/pipeline.ts';
import { MinuteBaseline, SecondRing } from './baseline.ts';
import { Detectors } from './detectors.ts';
import { IncidentManager } from './incidents.ts';
import { shortName } from './names.ts';

const T = 1_794_560_000_000;

// ---- helpers: hand-made routing events

let n = 0;
function route(
  kind: 'bgp.announce' | 'bgp.withdraw',
  prefix: string,
  opts: {
    asn?: number;
    ts?: number;
    peer?: string;
    collector?: string;
    path?: number[];
    simulated?: boolean;
  } = {},
): EventEnvelope {
  n += 1;
  return {
    v: 1,
    src: 'replay',
    eid: `replay:t-${n}`,
    kind,
    ts: opts.ts ?? T,
    its: opts.ts ?? T,
    entity: {
      prefix,
      collector: opts.collector ?? 'rrc00',
      ...(opts.asn !== undefined && { asn: opts.asn }),
    },
    data: {
      peer: opts.peer ?? '10.0.0.1',
      ...(opts.path && { path: opts.path }),
      ...(opts.simulated && { simulated: true }),
    },
  };
}

/** A pipeline whose events feed the detectors, as in the server. */
function rig(countries: Record<number, string> = {}) {
  const pipeline = new Pipeline({
    lookup: { asnCountry: (asn) => countries[asn], probe: () => undefined },
    onEvent: (e, ctx) => detectors.observe(e, ctx, e.ts),
    onSecond: () => {},
    onMinute: (w) => w.family === 'bgp' && detectors.onMinute(w.scopes),
  });
  const detectors = new Detectors({ origins: pipeline.origins, connectedProbes: () => 20 });
  const feed = (e: EventEnvelope) => pipeline.ingest([e], e.ts);
  const signals = (now: number, type?: Signal['type']) =>
    detectors.evaluate(now).filter((s) => !type || s.type === type);
  return { pipeline, detectors, feed, signals };
}

describe('baseline helpers', () => {
  it('scores a value against the median and MAD of recent minutes', () => {
    const b = new MinuteBaseline();
    for (const v of [10, 12, 9, 11, 10, 50]) b.push(v); // one wild minute barely matters
    expect(b.median()).toBe(10.5);
    expect(b.z(10.5)).toBe(0);
    expect(b.z(100)).toBeGreaterThan(20);
    expect(new MinuteBaseline().z(25)).toBe(25); // no history: the +1 floor
  });

  it('sums counts over the last N seconds', () => {
    const r = new SecondRing(120);
    r.add(T, 3);
    r.add(T + 31_000, 2); // within the last 60 s of T + 90 s
    r.add(T + 90_000, 5);
    expect(r.sum(T + 90_000, 60)).toBe(7);
    expect(r.sum(T + 90_000, 120)).toBe(10);
  });

  it('shortens RIPEstat holder names', () => {
    expect(shortName('FACEBOOK - Facebook, Inc., US')).toBe('Facebook, Inc.');
    expect(shortName('CLOUDFLARENET, US')).toBe('CLOUDFLARENET');
  });
});

describe('detectors', () => {
  const prefixes = (count: number, base = 100) =>
    Array.from({ length: count }, (_, i) => `${base}.${i}.0.0/16`);

  it('D1 and D1b: a network withdrawing most of its routes, seen by several peers', () => {
    const { feed, detectors, signals } = rig({ 100: 'NL' });
    detectors.seed(
      'asn:100',
      Array.from({ length: 60 }, () => 0),
    ); // a quiet hour
    for (const p of prefixes(30)) feed(route('bgp.announce', p, { asn: 100 }));
    // Every prefix withdrawn by 20 different routers.
    for (let r = 0; r < 20; r++) {
      for (const p of prefixes(30))
        feed(route('bgp.withdraw', p, { ts: T + 1000, peer: `10.0.0.${r}` }));
    }

    const storm = signals(T + 2000, 'withdrawal_storm').find((s) => s.scope === 'asn:100');
    expect(storm?.detail).toMatchObject({ withdrawals: 600, prefixes: 30, peers: 20 });
    const vanished = signals(T + 2000, 'network_vanished');
    expect(vanished).toEqual([
      expect.objectContaining({
        scope: 'asn:100',
        detail: expect.objectContaining({ gone: 30, known: 30 }),
      }),
    ]);
  });

  it('does not raise a storm for a network without enough history', () => {
    const { feed, signals } = rig();
    for (const p of prefixes(30)) feed(route('bgp.announce', p, { asn: 100 }));
    prefixes(30).forEach((p, i) =>
      feed(route('bgp.withdraw', p, { ts: T + 1000, peer: `p${i % 5}` })),
    );
    expect(signals(T + 2000, 'withdrawal_storm')).toEqual([]);
  });

  it('does not call it an outage when a single peer drops its routes (a session reset)', () => {
    const { feed, detectors, signals } = rig();
    detectors.seed(
      'asn:100',
      Array.from({ length: 60 }, () => 0),
    );
    for (const p of prefixes(30)) feed(route('bgp.announce', p, { asn: 100 }));
    for (const p of prefixes(30))
      feed(route('bgp.withdraw', p, { ts: T + 1000, peer: '10.0.0.9' }));
    expect(signals(T + 2000, 'network_vanished')).toEqual([]);
    expect(signals(T + 2000, 'withdrawal_storm')).toEqual([]);
  });

  it('D1 stays quiet for a network whose normal rate is this high', () => {
    const { feed, detectors, signals } = rig();
    detectors.seed(
      'asn:100',
      Array.from({ length: 60 }, () => 40),
    );
    for (const p of prefixes(30)) feed(route('bgp.announce', p, { asn: 100 }));
    prefixes(30).forEach((p, i) =>
      feed(route('bgp.withdraw', p, { ts: T + 1000, peer: `p${i % 3}` })),
    );
    expect(signals(T + 2000, 'withdrawal_storm')).toEqual([]);
  });

  it('D2: prefixes taken over by another network, confirmed at three collectors', () => {
    const { feed, signals } = rig();
    for (const p of prefixes(3)) feed(route('bgp.announce', p, { asn: 100 }));
    for (const p of prefixes(3))
      feed(route('bgp.announce', p, { asn: 666, collector: 'rrc00', path: [3356, 666] }));
    for (const p of prefixes(3))
      feed(route('bgp.announce', p, { asn: 666, collector: 'rrc10', path: [174, 666] }));
    expect(signals(T + 100, 'origin_change')).toEqual([]); // two collectors are not enough
    for (const p of prefixes(3))
      feed(route('bgp.announce', p, { asn: 666, collector: 'rrc11', path: [1299, 666] }));
    const [hijack] = signals(T + 100, 'origin_change');
    expect(hijack).toMatchObject({ scope: 'asn:100', detail: { hijacker: 666, prefixes: 3 } });
    expect(hijack!.weight).toBeCloseTo(0.45);
  });

  it('D2 ignores a new origin that has the old owner on its path, and shared prefixes', () => {
    const { feed, signals } = rig();
    feed(route('bgp.announce', '1.0.0.0/24', { asn: 100 }));
    feed(
      route('bgp.announce', '1.0.0.0/24', { asn: 200, collector: 'rrc00', path: [3356, 100, 200] }),
    );
    feed(
      route('bgp.announce', '1.0.0.0/24', { asn: 200, collector: 'rrc10', path: [174, 100, 200] }),
    );
    expect(signals(T + 100, 'origin_change')).toEqual([]);

    // Two networks taking turns on one prefix (anycast) are judged legitimate.
    feed(route('bgp.announce', '2.0.0.0/24', { asn: 100 }));
    feed(route('bgp.announce', '2.0.0.0/24', { asn: 300, collector: 'rrc00' }));
    feed(route('bgp.announce', '2.0.0.0/24', { asn: 100, collector: 'rrc00' }));
    feed(route('bgp.announce', '2.0.0.0/24', { asn: 300, collector: 'rrc00' }));
    feed(route('bgp.announce', '2.0.0.0/24', { asn: 300, collector: 'rrc10' }));
    expect(signals(T + 100, 'origin_change')).toEqual([]);
  });

  it("D3: a large share of a country's probes far slower than usual", () => {
    const detectors = new Detectors({ origins: new OriginTable(), connectedProbes: () => 10 });
    const ping = (id: number, rtt: number | null, ts: number): EventEnvelope => ({
      v: 1,
      src: 'atlas',
      eid: `atlas:${id}-${ts}`,
      kind: 'atlas.ping',
      ts,
      its: ts,
      entity: { probeId: id },
      data: { rtt },
    });
    const ctx = { asn: undefined, cc: 'DE', prevOrigin: undefined, masked: false };
    for (let round = 0; round < 4; round++) {
      for (let id = 1; id <= 10; id++) detectors.observe(ping(id, 20, T + round * 1000), ctx, T);
    }
    for (const id of [1, 2, 3]) detectors.observe(ping(id, 200, T + 5000), ctx, T);
    detectors.observe(ping(4, null, T + 5000), ctx, T);
    const [surge] = detectors.evaluate(T + 6000).filter((s) => s.type === 'latency_surge');
    expect(surge).toMatchObject({
      scope: 'country:DE',
      detail: { probes: 10, degraded: 4, share: 40 },
    });
  });

  it('D4: many probes in a country disconnecting together', () => {
    const detectors = new Detectors({ origins: new OriginTable(), connectedProbes: () => 20 });
    for (let id = 1; id <= 6; id++) {
      detectors.observe(
        {
          v: 1,
          src: 'atlas',
          eid: `atlas:s-${id}`,
          kind: 'atlas.probe_status',
          ts: T,
          its: T,
          entity: { probeId: id },
          data: { event: 'disconnect' },
        },
        { asn: undefined, cc: 'FR', prevOrigin: undefined, masked: false },
        T,
      );
    }
    const [drop] = detectors.evaluate(T + 1000).filter((s) => s.type === 'probe_dropout');
    expect(drop).toMatchObject({
      scope: 'country:FR',
      detail: { disconnected: 6, connected: 20, share: 30 },
    });
  });
});

describe('incident manager', () => {
  const signal = (
    type: Signal['type'],
    weight: number,
    at: number,
    detail: Signal['detail'] = {},
  ): Signal => ({
    type,
    scope: 'asn:100',
    at,
    weight,
    detail,
    simulated: false,
  });
  const make = () => {
    const changes: Incident[] = [];
    const m = new IncidentManager({
      nameOf: () => 'Example Net',
      countryOf: () => 'NL',
      onChange: (i) => changes.push(structuredClone(i)),
    });
    return { m, changes };
  };
  const storm = { withdrawals: 300, prefixes: 30, peers: 4, normalPerMinute: 1, times: 300 };
  const vanished = { known: 40, gone: 35, reachable: 5, share: 88, peers: 4 };

  it('does not open an incident on one weak signal', () => {
    const { m, changes } = make();
    m.report([signal('withdrawal_storm', 0.4, T, storm)], T);
    expect(m.active()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('opens a critical incident when signals agree, explains it, then resolves', () => {
    const { m, changes } = make();
    m.report([signal('withdrawal_storm', 0.4, T, storm)], T);
    m.report([signal('network_vanished', 0.6, T + 1000, vanished)], T + 1000);
    const [incident] = m.active();
    expect(incident).toMatchObject({
      scope: 'asn:100',
      asn: 100,
      cc: 'NL',
      state: 'open',
      severity: 'critical',
      score: 1,
    });
    expect(incident!.summary).toMatch(
      /Example Net \(AS100\) withdrew 300 routes for 30 address blocks/,
    );
    expect(incident!.summary).toMatch(
      /35 of its 40 known address blocks \(88%\) have been withdrawn/,
    );

    m.tick(T + 10_000); // signals stopped
    expect(m.active()[0]!.state).toBe('resolving');
    m.report([signal('network_vanished', 0.6, T + 12_000, vanished)], T + 12_000); // back
    expect(m.active()[0]!.state).toBe('open');
    m.tick(T + 12_000 + 61_000);
    m.tick(T + 12_000 + 62_000);
    expect(m.active()).toEqual([]);
    expect(changes.at(-1)).toMatchObject({ state: 'resolved' });
    expect(
      changes
        .at(-1)!
        .timeline.map((t) => t.text)
        .join(' | '),
    ).toMatch(/Resolved after/);
  });
});

describe('incident manager after a restart', () => {
  const sig = (
    type: Signal['type'],
    weight: number,
    at: number,
    detail: Signal['detail'] = {},
  ): Signal => ({
    type,
    scope: 'asn:100',
    at,
    weight,
    detail,
    simulated: false,
  });
  const storm = { withdrawals: 300, prefixes: 30, peers: 4, normalPerMinute: 1, times: 300 };
  const vanished = { known: 40, gone: 35, reachable: 5, share: 88, peers: 4 };
  const manager = () =>
    new IncidentManager({ nameOf: () => 'Example Net', countryOf: () => 'NL', onChange: () => {} });

  it('reopens the restored incident when the same outage continues, instead of opening a second', () => {
    const before = manager();
    before.report(
      [sig('withdrawal_storm', 0.4, T, storm), sig('network_vanished', 0.6, T, vanished)],
      T,
    );
    const original = structuredClone(before.active()[0]!);
    // The server dies; at startup the open incident is closed as an orphan...
    const closed = {
      ...original,
      state: 'resolved' as const,
      resolvedAt: T + 5000,
      updatedAt: T + 5000,
    };
    // ...and handed to the new manager, which then sees the outage again.
    const after = manager();
    expect(after.restore([closed], T + 6000)).toBe(1);
    after.report(
      [
        sig('withdrawal_storm', 0.4, T + 35_000, storm),
        sig('network_vanished', 0.6, T + 35_000, vanished),
      ],
      T + 35_000,
    );
    const [now] = after.active();
    expect(now!.id).toBe(original.id); // the same incident, reopened
    expect(now!.timeline.map((t) => t.text)).toContain('Reopened: the signals came back');
  });

  it('does not take back incidents resolved longer ago than the reopen window', () => {
    const m = manager();
    const old = {
      id: 'x',
      scope: 'asn:100',
      asn: 100,
      cc: 'NL',
      name: null,
      state: 'resolved' as const,
      severity: 'critical' as const,
      score: 1,
      peakScore: 1,
      openedAt: T - 3_600_000,
      updatedAt: T - 3_000_000,
      resolvedAt: T - 3_000_000,
      signals: [],
      timeline: [],
      summary: '',
      simulated: false,
    };
    expect(m.restore([old], T)).toBe(0);
  });

  it('writes the Cloudflare confirmation once in the timeline, not "Cloudflare Radar: Cloudflare Radar..."', () => {
    const m = manager();
    m.report(
      [
        sig('withdrawal_storm', 0.4, T, storm),
        sig('cloudflare', 0.3, T, { title: 'Route leak by AS100' }),
      ],
      T,
    );
    const texts = m.active()[0]!.timeline.map((t) => t.text);
    expect(texts).toContain('Cloudflare Radar reports it too: Route leak by AS100');
    expect(texts.some((t) => t.startsWith('Cloudflare Radar: Cloudflare'))).toBe(false);
  });
});

// ---- the real thing: the Facebook scenario through pipeline, detectors and incidents

describe('the Facebook outage scenario', () => {
  it('opens a critical incident for AS32934 within seconds, and resolves after the recovery', () => {
    const plan = facebookPlan(
      fileURLToPath(
        new URL('../../../../../deploy/seed/scenarios/facebook-2021.ndjson.gz', import.meta.url),
      ),
    );
    const T0 = T;
    const opened: Incident[] = [];
    const changes: Incident[] = [];
    const pipeline = new Pipeline({
      lookup: { asnCountry: (asn) => (asn === 32934 ? 'US' : undefined), probe: () => undefined },
      onEvent: (e, ctx) => detectors.observe(e, ctx, e.ts),
      onSecond: () => {},
      onMinute: (w) => w.family === 'bgp' && detectors.onMinute(w.scopes),
    });
    const detectors = new Detectors({ origins: pipeline.origins, connectedProbes: () => 0 });
    // Facebook's normal: practically no withdrawals (as before 15:39 in the recording).
    detectors.seed(
      'asn:32934',
      Array.from({ length: 60 }, () => 0),
    );
    const manager = new IncidentManager({
      nameOf: () => 'Facebook, Inc.',
      countryOf: () => 'US',
      onChange: (i) => {
        changes.push(structuredClone(i));
        if (!opened.some((o) => o.id === i.id)) opened.push(structuredClone(i));
      },
    });

    // Play the plan on a simulated clock: events stamped at their moment, detectors every second.
    let step = 0;
    for (let now = T0; now <= T0 + plan.durationMs + 70_000; now += 1000) {
      while (step < plan.steps.length && T0 + plan.steps[step]!.at <= now) {
        const s = plan.steps[step++]!;
        const at = T0 + s.at;
        pipeline.ingest(
          s.batch.map((e, i) => ({
            ...e,
            eid: `replay:sim:${step}:${i}`,
            ts: at,
            its: at,
            data: { ...e.data, simulated: true },
          })),
          at,
        );
      }
      pipeline.tick(now);
      manager.report(detectors.evaluate(now), now);
      manager.tick(now);
    }

    const fb = opened.find((i) => i.scope === 'asn:32934');
    expect(fb).toBeDefined();
    const firstWithdrawal = plan.steps.find((s) =>
      s.batch.some((e) => e.kind === 'bgp.withdraw' && e.data.part === 'outage'),
    )!;
    const detectedAfter = fb!.openedAt - (T0 + firstWithdrawal.at);
    expect(detectedAfter).toBeLessThan(30_000);

    const peak = changes
      .filter((c) => c.scope === 'asn:32934')
      .reduce((a, b) => (b.peakScore > a.peakScore ? b : a));
    expect(peak.severity).toBe('critical');
    expect(peak.signals.map((s) => s.type).sort()).toEqual([
      'network_vanished',
      'withdrawal_storm',
    ]);
    expect(peak.simulated).toBe(true);
    expect(peak.summary).toMatch(/Facebook, Inc\. \(AS32934\)/);

    const last = changes.filter((c) => c.scope === 'asn:32934').at(-1)!;
    expect(last.state).toBe('resolved');
    // eslint-disable-next-line no-console -- recorded in docs/benchmarks.md
    console.log(
      `Facebook scenario: incident opened ${(detectedAfter / 1000).toFixed(1)} s after the first withdrawal, peak score ${peak.peakScore}, resolved ${((last.resolvedAt! - T0) / 1000).toFixed(0)} s after the start`,
    );
  });
});
