import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  atlasPingSchema,
  atlasProbeStatusSchema,
  risMessageSchema,
  type EventEnvelope,
} from '@ins/shared';
import { describe, expect, it } from 'vitest';
import { normaliseAtlasPing, normaliseAtlasStatus, normaliseRis } from '../sources/normalise.ts';
import { applyEvent, finalise, newAgg } from './aggregate.ts';
import { Deduper } from './dedupe.ts';
import { OriginTable } from './origins.ts';
import { Pipeline, type WindowResult } from './pipeline.ts';
import { Watermark } from './watermark.ts';
import { TumblingWindows } from './windows.ts';

const T = 1_794_560_000_000; // a round "now" for hand-written cases

describe('Deduper', () => {
  it('reports an ID as duplicate only the second time', () => {
    const d = new Deduper();
    expect(d.isDuplicate('ris:a#0', T)).toBe(false);
    expect(d.isDuplicate('ris:b#0', T)).toBe(false);
    expect(d.isDuplicate('ris:a#0', T + 1)).toBe(true);
  });

  it('remembers an ID for at least one rotation and forgets it after two', () => {
    const d = new Deduper(1000);
    d.isDuplicate('x', T);
    expect(d.isDuplicate('x', T + 1500)).toBe(true); // one rotation later: still known
    d.isDuplicate('y', T + 2600); // second rotation
    d.isDuplicate('z', T + 3700); // third rotation: 'x' has aged out
    expect(d.isDuplicate('x', T + 3800)).toBe(false);
    expect(d.size).toBeLessThanOrEqual(3);
  });
});

describe('Watermark', () => {
  const opts = { latenessMs: 5000, maxSkewMs: 15_000, idleMs: 30_000 };

  it('follows the slowest healthy partition, minus the allowed lateness', () => {
    const w = new Watermark(opts);
    w.observe('rrc00', T + 10_000, T + 11_000);
    w.observe('rrc10', T + 4_000, T + 11_000);
    expect(w.current(T + 11_000)).toBe(T + 4_000 - 5000);
  });

  it('stops waiting for a partition that is too far behind the leader', () => {
    const w = new Watermark(opts);
    w.observe('rrc00', T + 60_000, T + 61_000);
    w.observe('rrc10', T + 20_000, T + 61_000); // 40 s behind: more than maxSkew
    expect(w.current(T + 61_000)).toBe(T + 60_000 - 5000);
  });

  it('ignores a partition that has gone quiet', () => {
    const w = new Watermark(opts);
    w.observe('rrc10', T, T);
    w.observe('rrc00', T + 50_000, T + 50_000); // rrc10 last heard 50 s ago
    expect(w.current(T + 50_000)).toBe(T + 50_000 - 5000);
  });

  it('refuses timestamps from the future and is not moved by them', () => {
    const w = new Watermark(opts);
    w.observe('atlas', T, T);
    expect(w.observe('atlas', T + 3 * 3600_000, T)).toBe(false); // a probe 3 hours ahead
    expect(w.observe('atlas', T + 30_000, T)).toBe(true); // within tolerance
    expect(w.current(T)).toBe(T + 30_000 - 5000);
  });

  it('never moves backwards', () => {
    const w = new Watermark(opts);
    w.observe('a', T + 20_000, T + 20_000);
    const before = w.current(T + 20_000);
    w.observe('b', T + 10_000, T + 20_000); // a new, slower partition appears
    expect(w.current(T + 20_000)).toBe(before);
  });

  it('releases everything once every partition is idle', () => {
    const w = new Watermark(opts);
    w.observe('a', T + 1000, T + 1000);
    expect(w.current(T + 1000)).toBe(T + 1000 - 5000);
    expect(w.current(T + 1000 + 31_000)).toBe(T + 1000);
  });
});

describe('TumblingWindows', () => {
  const make = () => new TumblingWindows<{ n: number }>(1000, () => ({ n: 0 }));

  it('groups by event time, whatever the arrival order', () => {
    const w = make();
    for (const ts of [T + 2100, T + 100, T + 1900, T + 900, T + 2050]) w.slot('world', ts)!.n += 1;
    const closed = w.close(T + 3000);
    expect(closed.map((c) => [c.start - T, c.scopes.get('world')!.n])).toEqual([
      [0, 2],
      [1000, 1],
      [2000, 2],
    ]);
  });

  it('closes a window only when the watermark passes its end, and only once', () => {
    const w = make();
    w.slot('world', T + 100)!.n += 1;
    expect(w.close(T + 999)).toEqual([]);
    expect(w.close(T + 1000)).toHaveLength(1);
    expect(w.close(T + 1000)).toEqual([]);
    expect(w.openCount).toBe(0);
  });

  it('refuses an event whose window has already closed', () => {
    const w = make();
    w.slot('world', T + 100)!.n += 1;
    w.close(T + 2000);
    expect(w.slot('world', T + 500)).toBeNull(); // late
    expect(w.slot('world', T + 1500)).toBeNull(); // its window was empty but is closed too
    expect(w.slot('world', T + 2500)).not.toBeNull();
  });

  it('keeps scopes apart inside a window', () => {
    const w = make();
    w.slot('world', T)!.n += 2;
    w.slot('asn:32934', T)!.n += 1;
    const [closed] = w.close(T + 1000);
    expect(Object.fromEntries(closed!.scopes)).toEqual({ world: { n: 2 }, 'asn:32934': { n: 1 } });
  });
});

describe('aggregates', () => {
  const event = (
    kind: EventEnvelope['kind'],
    extra: Partial<EventEnvelope> = {},
  ): EventEnvelope => ({
    v: 1,
    src: 'replay',
    eid: 'replay:x',
    kind,
    ts: T,
    its: T,
    entity: {},
    data: {},
    ...extra,
  });

  it('counts routes and distinct withdrawn prefixes', () => {
    const agg = newAgg();
    applyEvent(agg, event('bgp.announce'));
    applyEvent(agg, event('bgp.withdraw', { entity: { prefix: '1.0.0.0/24' } }));
    applyEvent(agg, event('bgp.withdraw', { entity: { prefix: '1.0.0.0/24' } }));
    applyEvent(agg, event('bgp.withdraw', { entity: { prefix: '2.0.0.0/24' } }));
    expect(finalise(agg)).toMatchObject({ ann: 1, wd: 3, pfx: 2, p50: null, pings: 0 });
  });

  it('computes latency percentiles and counts lost pings', () => {
    const agg = newAgg();
    for (let ms = 1; ms <= 100; ms++) applyEvent(agg, event('atlas.ping', { data: { rtt: ms } }));
    applyEvent(agg, event('atlas.ping', { data: { rtt: null } }));
    applyEvent(agg, event('atlas.probe_status', { data: { event: 'disconnect' } }));
    expect(finalise(agg)).toMatchObject({ p50: 50, p95: 95, pings: 101, lost: 1, left: 1 });
  });
});

describe('OriginTable', () => {
  it('learns owners and stops learning new prefixes when full', () => {
    const table = new OriginTable(2);
    table.learn('1.0.0.0/24', 13335);
    table.learn('2.0.0.0/24', 32934);
    table.learn('3.0.0.0/24', 15169); // table full
    table.learn('1.0.0.0/24', 64512); // known prefix: still updated
    expect(table.originOf('1.0.0.0/24')).toBe(64512);
    expect(table.originOf('3.0.0.0/24')).toBeUndefined();
    expect(table).toMatchObject({ size: 2, skipped: 1 });
  });
});

// ---- the whole pipeline on real recorded traffic (13 Nov 2026, see docs/benchmarks.md)

interface Recorded {
  its: number;
  batch: EventEnvelope[];
}

function load(name: string): { its: number; m: unknown }[] {
  const file = new URL(`./fixtures/${name}`, import.meta.url);
  return gunzipSync(readFileSync(file))
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { its: number; m: unknown });
}

const risBatches: Recorded[] = load('ris-3000.ndjson.gz').map(({ its, m }) => ({
  its,
  batch: normaliseRis(risMessageSchema.parse(m).data, its),
}));

const atlasBatches: Recorded[] = load('atlas-2000.ndjson.gz').map(({ its, m }) => {
  const [name, payload] = m as [string, unknown];
  const event =
    name === 'atlas_result'
      ? normaliseAtlasPing(atlasPingSchema.parse(payload), its)
      : normaliseAtlasStatus(atlasProbeStatusSchema.parse(payload), its);
  return { its, batch: [event] };
});

function run(recorded: Recorded[], repeat = 1) {
  const seconds: WindowResult[] = [];
  const minutes: WindowResult[] = [];
  const pipeline = new Pipeline({
    onSecond: (w) => seconds.push(w),
    onMinute: (w) => minutes.push(w),
  });
  for (let pass = 0; pass < repeat; pass++) {
    for (const { its, batch } of recorded) {
      pipeline.ingest(batch, its);
      pipeline.tick(its);
    }
  }
  pipeline.flush();
  return { pipeline, seconds, minutes };
}

const sum = (windows: WindowResult[], scope: string, field: 'ann' | 'wd' | 'pings') =>
  windows.reduce((total, w) => total + (w.scopes.get(scope)?.[field] ?? 0), 0);

describe('Pipeline on recorded RIS traffic', () => {
  const offered = risBatches.reduce((n, r) => n + r.batch.length, 0);
  const { pipeline, seconds, minutes } = run(risBatches);
  const c = pipeline.counters;

  it('accounts for every event: counted, late or dropped, never lost', () => {
    expect(c.received).toBe(offered);
    expect(c.counted + c.lateMinute + c.future + c.duplicates).toBe(offered);
    expect(sum(minutes, 'world', 'ann') + sum(minutes, 'world', 'wd')).toBe(c.counted);
  });

  it('puts every event that was on time into exactly one 1-second window', () => {
    const inSeconds = sum(seconds, 'world', 'ann') + sum(seconds, 'world', 'wd');
    expect(inSeconds + c.lateSecond).toBe(c.counted + c.lateMinute);
    // Windows are emitted in time order and never twice.
    const starts = seconds.map((w) => w.start);
    expect(starts).toEqual([...new Set(starts)].sort((a, b) => a - b));
  });

  it('attributes announcements to their origin network', () => {
    const perAsn = minutes.flatMap((w) => [...w.scopes.keys()]).filter((k) => k.startsWith('asn:'));
    expect(perAsn.length).toBeGreaterThan(100);
    expect(pipeline.origins.size).toBeGreaterThan(1000);
  });

  it('counts nothing twice when the same traffic arrives again', () => {
    const twice = run(risBatches, 2);
    expect(twice.pipeline.counters.duplicates).toBe(offered);
    expect(twice.pipeline.counters.counted).toBe(c.counted);
    expect(sum(twice.minutes, 'world', 'ann')).toBe(sum(minutes, 'world', 'ann'));
    expect(sum(twice.minutes, 'world', 'wd')).toBe(sum(minutes, 'world', 'wd'));
  });

  it('gives the same result every time', () => {
    const again = run(risBatches);
    expect(again.pipeline.counters).toEqual(c);
    expect(again.seconds).toEqual(seconds);
  });
});

describe('Pipeline on recorded Atlas traffic', () => {
  const { pipeline, minutes } = run(atlasBatches);
  const c = pipeline.counters;

  it('accounts for every result and produces latency percentiles', () => {
    expect(c.received).toBe(atlasBatches.length);
    expect(c.counted + c.lateMinute + c.future + c.duplicates).toBe(atlasBatches.length);
    const withLatency = minutes.filter((w) => typeof w.scopes.get('world')?.p50 === 'number');
    expect(withLatency.length).toBeGreaterThan(0);
    for (const w of withLatency) {
      const world = w.scopes.get('world')!;
      expect(world.p95!).toBeGreaterThanOrEqual(world.p50!);
      expect(w.family).toBe('atlas');
    }
  });

  it('sets aside a result stamped hours in the future without disturbing the rest', () => {
    const [first, ...rest] = atlasBatches;
    const bad: Recorded = {
      its: first!.its,
      batch: [{ ...first!.batch[0]!, eid: 'atlas:bad-clock', ts: first!.its + 3 * 3600_000 }],
    };
    const withBad = run([first!, bad, ...rest]);
    expect(withBad.pipeline.counters.future).toBe(c.future + 1);
    expect(withBad.pipeline.counters.counted).toBe(c.counted);
    expect(withBad.pipeline.counters.lateMinute).toBe(c.lateMinute);
  });
});

describe('Pipeline country scopes', () => {
  const lookup = {
    asnCountry: (asn: number) => (asn === 32934 ? 'US' : asn === 9829 ? 'IN' : undefined),
    probe: (id: number) => (id === 7 ? { cc: 'DE', asn: 3320 } : undefined),
  };
  const base = { v: 1 as const, src: 'replay' as const, its: T, data: {} };

  it('puts routing events in the country their network is registered in', () => {
    const seconds: WindowResult[] = [];
    const minutes: WindowResult[] = [];
    const p = new Pipeline({
      lookup,
      onSecond: (w) => seconds.push(w),
      onMinute: (w) => minutes.push(w),
    });
    p.ingest(
      [
        {
          ...base,
          eid: 'replay:a#0',
          kind: 'bgp.announce',
          ts: T,
          entity: { prefix: '157.240.0.0/16', asn: 32934, collector: 'rrc00' },
        },
      ],
      T,
    );
    // A withdrawal names no network; the owner comes from the announcement above.
    p.ingest(
      [
        {
          ...base,
          eid: 'replay:b#0',
          kind: 'bgp.withdraw',
          ts: T + 10,
          entity: { prefix: '157.240.0.0/16', collector: 'rrc00' },
        },
      ],
      T,
    );
    p.ingest(
      [
        {
          ...base,
          eid: 'replay:c#0',
          kind: 'bgp.announce',
          ts: T + 20,
          entity: { prefix: '10.0.0.0/8', asn: 64512, collector: 'rrc00' },
        },
      ],
      T,
    );
    p.flush();

    const minute = minutes.find((w) => w.family === 'bgp')!;
    expect(minute.scopes.get('country:US')).toMatchObject({ ann: 1, wd: 1, pfx: 1 });
    expect(minute.scopes.get('asn:32934')).toMatchObject({ ann: 1, wd: 1 });
    expect(minute.scopes.get('world')).toMatchObject({ ann: 2, wd: 1 });
    expect([...minute.scopes.keys()].filter((k) => k.startsWith('country:'))).toEqual([
      'country:US',
    ]);
    expect(seconds[0]!.scopes.get('country:US')).toMatchObject({ ann: 1, wd: 1 });
  });

  it("puts latency results in the probe's own country and network", () => {
    const minutes: WindowResult[] = [];
    const p = new Pipeline({ lookup, onSecond: () => {}, onMinute: (w) => minutes.push(w) });
    p.ingest(
      [
        {
          ...base,
          src: 'atlas',
          eid: 'atlas:1-7-1',
          kind: 'atlas.ping',
          ts: T,
          entity: { probeId: 7 },
          data: { rtt: 12.5 },
        },
      ],
      T,
    );
    p.ingest(
      [
        {
          ...base,
          src: 'atlas',
          eid: 'atlas:1-8-1',
          kind: 'atlas.ping',
          ts: T,
          entity: { probeId: 8 },
          data: { rtt: null },
        },
      ],
      T,
    );
    p.flush();
    const [minute] = minutes;
    expect(minute!.scopes.get('country:DE')).toMatchObject({ p50: 12.5, pings: 1, up: 1 });
    expect(minute!.scopes.get('asn:3320')).toMatchObject({ pings: 1 });
    expect(minute!.scopes.get('world')).toMatchObject({ pings: 2, lost: 1, up: 2 });
  });
});
