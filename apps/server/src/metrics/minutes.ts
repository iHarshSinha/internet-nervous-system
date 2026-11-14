import type { StatsRow } from '../db/ingestStats.ts';
import type { IngestState } from '../ingest/protocol.ts';

/** What one minute's record is built from: running totals and current readings. */
export interface MinuteInputs {
  ingest: IngestState;
  sockets: number;
  delivery: { packets: number; bytes: number; feedBatches: number };
  broadcast: { frames: number; deltas: number };
  slowNow: number;
  mainLoopP99: number;
  store: { docs: number; lastWriteMs: number | null };
}

/**
 * Turns running totals into per-minute rows for ingest_stats.
 *
 * Totals only ever grow (until a restart), so a minute's value is the total
 * now minus the total at the previous minute. The first minute after a start
 * has no "previous" and is skipped rather than recorded as a spike. A total
 * that went DOWN means the ingest thread restarted; the new total is then
 * the minute's value.
 */
export class MinuteRecorder {
  private prev: Map<string, number> | null = null;

  /** The rows for the minute that started at `t`, or [] for the first call. */
  rows(t: number, now: MinuteInputs): StatsRow[] {
    const totals = new Map<string, number>();
    const put = (key: string, value: number) => totals.set(key, value);
    const s = now.ingest;

    for (const [src, c] of Object.entries(s.sources)) {
      if (!c) continue;
      put(`${src}.messages`, c.messages);
      put(`${src}.events`, c.events);
      put(`${src}.rejected`, c.rejected);
      put(`${src}.warnings`, c.warnings);
      put(`${src}.lagSumMs`, c.lagSumMs);
      put(`${src}.lagCount`, c.lagCount);
    }
    const p = s.pipeline as Record<string, unknown>;
    for (const k of [
      'received',
      'duplicates',
      'amendedSecond',
      'lateSecond',
      'lateMinute',
      'future',
      'counted',
    ]) {
      put(`pipeline.${k}`, typeof p[k] === 'number' ? p[k] : 0);
    }
    put('pipeline.shed', s.queue.shedTotal);
    put('pipeline.overflow', s.queue.overflow);
    put('pipeline.sampledOut', s.feedSampledOut);
    put('delivery.frames', now.broadcast.frames);
    put('delivery.deltas', now.broadcast.deltas);
    put('delivery.packets', now.delivery.packets);
    put('delivery.bytes', now.delivery.bytes);
    put('delivery.feedBatches', now.delivery.feedBatches);
    put('delivery.mongoDocs', now.store.docs);

    const prev = this.prev;
    this.prev = totals;
    if (!prev) return [];
    const d = (key: string) => {
      const a = totals.get(key) ?? 0;
      const b = prev.get(key) ?? 0;
      return a >= b ? a - b : a;
    };

    const rows: StatsRow[] = [];
    for (const src of Object.keys(s.sources)) {
      const lagCount = d(`${src}.lagCount`);
      rows.push({
        src,
        t,
        messages: d(`${src}.messages`),
        events: d(`${src}.events`),
        rejected: d(`${src}.rejected`),
        warnings: d(`${src}.warnings`),
        lagMs: lagCount > 0 ? Math.round(d(`${src}.lagSumMs`) / lagCount) : 0,
      });
    }
    rows.push({
      src: 'pipeline',
      t,
      received: d('pipeline.received'),
      duplicates: d('pipeline.duplicates'),
      amendedSecond: d('pipeline.amendedSecond'),
      lateSecond: d('pipeline.lateSecond'),
      lateMinute: d('pipeline.lateMinute'),
      future: d('pipeline.future'),
      counted: d('pipeline.counted'),
      shed: d('pipeline.shed'),
      overflow: d('pipeline.overflow'),
      sampledOut: d('pipeline.sampledOut'),
      queueDepth: s.queue.depth,
      queueWaitMaxMs: s.queue.waitMaxMs,
      sampleEvery: s.queue.sampleEvery,
      delayP50: s.delay.p50,
      delayP95: s.delay.p95,
      delayP99: s.delay.p99,
      ingestLoopP99: s.thread.loopDelayMs,
      ingestHeapMb: s.thread.heapMb,
    });
    rows.push({
      src: 'delivery',
      t,
      sockets: now.sockets,
      frames: d('delivery.frames'),
      deltas: d('delivery.deltas'),
      packets: d('delivery.packets'),
      bytes: d('delivery.bytes'),
      feedBatches: d('delivery.feedBatches'),
      slowNow: now.slowNow,
      mainLoopP99: now.mainLoopP99,
      mongoDocs: d('delivery.mongoDocs'),
      mongoWriteMs: now.store.lastWriteMs ?? 0,
    });
    return rows;
  }
}
