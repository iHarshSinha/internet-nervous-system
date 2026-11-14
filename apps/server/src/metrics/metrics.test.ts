import { describe, expect, it } from 'vitest';
import type { IngestState } from '../ingest/protocol.ts';
import { MinuteRecorder, type MinuteInputs } from './minutes.ts';
import { RecentQuantiles } from './quantiles.ts';

describe('RecentQuantiles', () => {
  it('reports percentiles of recent values and forgets old buckets', () => {
    const q = new RecentQuantiles({ buckets: 2, bucketMs: 60_000 });
    for (let v = 1; v <= 100; v++) q.add(v);
    expect(q.snapshot()).toMatchObject({ p50: 51, p95: 96, p99: 100, max: 100, n: 100 });
    q.rotate();
    q.add(1000);
    expect(q.snapshot().max).toBe(1000); // both buckets still counted
    q.rotate(); // the first bucket (1..100) drops out
    expect(q.snapshot()).toMatchObject({ p50: 1000, n: 1 });
  });

  it('keeps a bounded sample however many values arrive', () => {
    const q = new RecentQuantiles({ cap: 50, bucketMs: 60_000 });
    for (let v = 0; v < 10_000; v++) q.add(v);
    expect(q.snapshot().n).toBe(10_000); // counted
    expect(q.snapshot().p50).toBeGreaterThan(1000); // a fair sample, not the first 50
  });
});

function inputs(events: number, duplicates: number, bytes: number): MinuteInputs {
  const ingest = {
    sources: {
      ris: {
        messages: events / 2,
        events,
        rejected: 1,
        warnings: 0,
        lagSumMs: events * 500,
        lagCount: events,
      },
    },
    pipeline: {
      received: events,
      duplicates,
      lateSecond: 0,
      lateMinute: 2,
      future: 0,
      counted: events - duplicates,
    },
    queue: { depth: 3, waitMaxMs: 4, sampleEvery: 1, shedTotal: 0, overflow: 0 },
    feedSampledOut: 0,
    delay: { p50: 5, p95: 20, p99: 40, max: 50, n: 100 },
    thread: { rssMb: 300, heapMb: 60, loopDelayMs: 11 },
  } as unknown as IngestState;
  return {
    ingest,
    sockets: 7,
    delivery: { packets: 10, bytes, feedBatches: 0 },
    broadcast: { frames: 100, deltas: 1000 },
    slowNow: 0,
    mainLoopP99: 12,
    store: { docs: 40, lastWriteMs: 9 },
  };
}

describe('MinuteRecorder', () => {
  it('skips the first minute, then records what each minute added', () => {
    const r = new MinuteRecorder();
    expect(r.rows(0, inputs(1000, 10, 5000))).toEqual([]);
    const rows = r.rows(60_000, inputs(4000, 16, 9000));
    const by = Object.fromEntries(rows.map((row) => [row.src, row]));
    expect(by.ris).toMatchObject({
      t: 60_000,
      events: 3000,
      messages: 1500,
      rejected: 0,
      lagMs: 500,
    });
    expect(by.pipeline).toMatchObject({
      received: 3000,
      duplicates: 6,
      delayP99: 40,
      queueDepth: 3,
    });
    expect(by.delivery).toMatchObject({
      sockets: 7,
      bytes: 4000,
      mainLoopP99: 12,
      mongoWriteMs: 9,
    });
  });

  it('treats a total that went down as a restart of the ingest thread', () => {
    const r = new MinuteRecorder();
    r.rows(0, inputs(5000, 0, 0));
    const rows = r.rows(60_000, inputs(800, 0, 0)); // thread restarted, counting from zero
    expect(rows.find((row) => row.src === 'ris')).toMatchObject({ events: 800 });
  });
});
