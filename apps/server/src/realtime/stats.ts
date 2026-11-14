import { rooms, type DeltaValue } from '@ins/shared';
import type { IngestLink } from '../ingest/link.ts';
import type { RecentQuantiles } from '../metrics/quantiles.ts';
import type { Broadcaster } from './broadcaster.ts';

export interface StatsSources {
  broadcaster: Broadcaster;
  ingest: IngestLink;
  sockets(): Record<string, number>;
  delivery: { packets: number; bytes: number; feedBatches: number };
  frames(): number;
  slowNow(): number;
  store: { docs: number; lastWriteMs: number | null };
  mainLoop(): { p50: number; p99: number };
  /** Window-to-publish delays (ms) over the last 10 s. */
  publish: RecentQuantiles;
  intervalMs?: number;
}

/**
 * The public `stats` room: the server's own numbers, once a second, for the
 * /ops page and the HUD. Keys and fields:
 *
 *   in:<source>  eps (events/s), lag (s, mean age on arrival)
 *   pipe         rps (events processed/s), dup, late, amended, future (running totals)
 *   queue        depth, fill, waitMs, every (raw-feed 1-in-k), pressure, shed, overflow
 *   delay        p50, p95, p99: arrival to processed, ms, last 10 s
 *   pub          p50, p95: end of a second (event time) to its frame leaving, ms
 *   loop         main, ingest: event-loop delay p99, ms
 *   mem          ingestHeap, rss (MB)
 *   out          bps (bytes/s), fps (frames/s), pps (packets/s), feeds (batches/s)
 *   sock         live, user, admin, slow
 *   mongo        writeMs (last bulk write), dps (documents upserted/s)
 *
 * Like every room, only changed values are sent, and nothing is staged while
 * nobody is watching.
 */
export function startStats(src: StatsSources): () => void {
  const intervalMs = src.intervalMs ?? 1000;
  const perSec = 1000 / intervalMs;
  let prev: Map<string, number> | null = null;

  const timer = setInterval(() => {
    const b = src.broadcaster;
    if (!b.hasMembers(rooms.stats)) {
      prev = null; // rates restart cleanly when someone joins
      return;
    }
    const put = (key: string, field: string, value: DeltaValue) =>
      b.set(rooms.stats, key, field, value);
    const s = src.ingest.snapshot();
    const p = s.pipeline as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' ? v : 0);

    // Running totals; per-second rates are the change since the last tick.
    const totals = new Map<string, number>([
      ['received', num(p.received)],
      ['bytes', src.delivery.bytes],
      ['packets', src.delivery.packets],
      ['feeds', src.delivery.feedBatches],
      ['frames', src.frames()],
      ['docs', src.store.docs],
    ]);
    for (const [source, c] of Object.entries(s.sources)) {
      totals.set(`events:${source}`, c?.events ?? 0);
      totals.set(`lagSum:${source}`, c?.lagSumMs ?? 0);
      totals.set(`lagCount:${source}`, c?.lagCount ?? 0);
    }
    const last = prev;
    prev = totals;
    const rate = (key: string) => {
      if (!last) return null;
      const d = (totals.get(key) ?? 0) - (last.get(key) ?? 0);
      return d >= 0 ? Math.round(d * perSec) : null; // negative: the ingest thread restarted
    };

    for (const source of Object.keys(s.sources)) {
      const eps = rate(`events:${source}`);
      if (eps !== null) put(`in:${source}`, 'eps', eps);
      if (last) {
        const n = (totals.get(`lagCount:${source}`) ?? 0) - (last.get(`lagCount:${source}`) ?? 0);
        const sum = (totals.get(`lagSum:${source}`) ?? 0) - (last.get(`lagSum:${source}`) ?? 0);
        if (n > 0) put(`in:${source}`, 'lag', Math.round(sum / n / 100) / 10);
      }
    }

    const rps = rate('received');
    if (rps !== null) put('pipe', 'rps', rps);
    put('pipe', 'dup', num(p.duplicates));
    put('pipe', 'late', num(p.lateMinute));
    put('pipe', 'amended', num(p.amendedSecond));
    put('pipe', 'future', num(p.future));

    const q = s.queue;
    put('queue', 'depth', q.depth);
    put('queue', 'fill', Math.round(q.fill * 1000) / 1000);
    put('queue', 'waitMs', q.waitMaxMs);
    put('queue', 'every', q.sampleEvery);
    put('queue', 'pressure', q.pressure);
    put('queue', 'shed', q.shedTotal);
    put('queue', 'overflow', q.overflow);

    put('delay', 'p50', s.delay.p50);
    put('delay', 'p95', s.delay.p95);
    put('delay', 'p99', s.delay.p99);
    const pub = src.publish.snapshot();
    if (pub.n > 0) {
      put('pub', 'p50', pub.p50);
      put('pub', 'p95', pub.p95);
    }

    put('loop', 'main', src.mainLoop().p99);
    put('loop', 'ingest', s.thread.loopDelayMs);
    put('mem', 'ingestHeap', s.thread.heapMb);
    put('mem', 'rss', Math.round(process.memoryUsage().rss / 1048576));

    for (const [field, key] of [
      ['bps', 'bytes'],
      ['fps', 'frames'],
      ['pps', 'packets'],
      ['feeds', 'feeds'],
    ] as const) {
      const r = rate(key);
      if (r !== null) put('out', field, r);
    }
    for (const [ns, n] of Object.entries(src.sockets())) put('sock', ns, n);
    put('sock', 'slow', src.slowNow());

    if (src.store.lastWriteMs !== null) put('mongo', 'writeMs', src.store.lastWriteMs);
    const dps = rate('docs');
    if (dps !== null) put('mongo', 'dps', dps);
  }, intervalMs);

  return () => clearInterval(timer);
}
