import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { IngestLink } from '../ingest/link.ts';
import { LoopDelay } from './loop.ts';

/** What the metrics read from the rest of the server when Prometheus scrapes. */
export interface MetricsSources {
  ingest: IngestLink;
  sockets(): Record<string, number>;
  delivery: { packets: number; bytes: number; feedBatches: number };
  broadcast: { frames: number; deltas: number };
  slow: { downgrades: number; recoveries: number; summaries: number; slowNow: number };
  store: { docs: number; errors: number };
}

export interface ServerMetrics {
  registry: Registry;
  /** Time of one MongoDB bulk write of closed minutes. */
  mongoWrite: Histogram;
  /** From the end of a 1-second window (event time) to the frame carrying it leaving the server. */
  windowToPublish: Histogram;
  /** The main thread's own event-loop delay, ms, for the per-minute record. */
  mainLoop(): { p50: number; p99: number };
  stop(): void;
}

/**
 * A counter whose value lives elsewhere as a running total (the ingest
 * thread's counters, the broadcaster's stats). On each scrape the counter is
 * moved forward by however much the total grew, so it stays a proper
 * Prometheus counter (it only ever goes up).
 */
function mirrored(
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[],
  read: () => [Record<string, string>, number][],
): Counter {
  const last = new Map<string, number>();
  return new Counter({
    name,
    help,
    labelNames,
    registers: [registry],
    collect() {
      for (const [labels, total] of read()) {
        const key = JSON.stringify(labels);
        const delta = total - (last.get(key) ?? 0);
        // A smaller total means the ingest thread restarted: count from zero again.
        if (delta > 0) this.inc(labels, delta);
        last.set(key, total);
      }
    },
  });
}

function gauge(
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[],
  read: () => [Record<string, string>, number][],
): Gauge {
  return new Gauge({
    name,
    help,
    labelNames,
    registers: [registry],
    collect() {
      for (const [labels, value] of read()) this.set(labels, value);
    },
  });
}

/**
 * Server metrics in Prometheus format (prom-client), served at /metrics.
 * Names start with `ins_`; Node's own process metrics with `ins_node_`.
 */
export function createMetrics(src: MetricsSources): ServerMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'ins_node_' });
  const state = () => src.ingest.snapshot();
  const none: Record<string, string> = {};

  // ---- Ingest: what came in, per source.
  const perSource = (field: 'messages' | 'events' | 'rejected' | 'warnings') => () =>
    Object.entries(state().sources).map(
      ([source, c]) => [{ source }, c?.[field] ?? 0] as [Record<string, string>, number],
    );
  mirrored(
    registry,
    'ins_upstream_messages_total',
    'Upstream messages received',
    ['source'],
    perSource('messages'),
  );
  mirrored(
    registry,
    'ins_events_total',
    'Events produced from upstream messages',
    ['source'],
    perSource('events'),
  );
  mirrored(
    registry,
    'ins_rejected_total',
    'Messages that failed validation',
    ['source'],
    perSource('rejected'),
  );
  mirrored(
    registry,
    'ins_upstream_warnings_total',
    'Notices from a feed about itself (Atlas drop warnings are upstream backpressure)',
    ['source'],
    perSource('warnings'),
  );

  // ---- Pipeline: dedupe and lateness.
  const pipe = () => state().pipeline as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  mirrored(registry, 'ins_duplicates_total', 'Events dropped as duplicates', [], () => [
    [none, num(pipe().duplicates)],
  ]);
  mirrored(
    registry,
    'ins_late_total',
    'Events that arrived after their window closed',
    ['window'],
    () => [
      [{ window: 'second' }, num(pipe().lateSecond)],
      [{ window: 'minute' }, num(pipe().lateMinute)],
    ],
  );
  mirrored(registry, 'ins_future_total', 'Events stamped ahead of our clock', [], () => [
    [none, num(pipe().future)],
  ]);
  mirrored(registry, 'ins_counted_total', 'Events counted in a 1-minute window', [], () => [
    [none, num(pipe().counted)],
  ]);

  // ---- Queue, sampling, shedding.
  const q = () => state().queue;
  gauge(registry, 'ins_queue_depth', 'Events waiting for the pipeline', [], () => [
    [none, q().depth],
  ]);
  gauge(registry, 'ins_queue_fill_ratio', 'Queue depth / capacity', [], () => [[none, q().fill]]);
  gauge(registry, 'ins_queue_wait_max_ms', 'Longest queue wait in the last second', [], () => [
    [none, q().waitMaxMs],
  ]);
  gauge(registry, 'ins_feed_sample_every', 'The raw feed keeps 1 event in this many', [], () => [
    [none, q().sampleEvery],
  ]);
  mirrored(registry, 'ins_shed_total', 'Events dropped by priority under load', ['kind'], () =>
    Object.entries(q().shed).map(([kind, n]) => [{ kind }, n ?? 0]),
  );
  mirrored(registry, 'ins_overflow_total', 'Events refused at the queue hard limit', [], () => [
    [none, q().overflow],
  ]);
  mirrored(
    registry,
    'ins_queue_pauses_total',
    'Times a file source waited for the queue',
    [],
    () => [[none, q().pauses]],
  );
  mirrored(
    registry,
    'ins_feed_sampled_out_total',
    'Events left out of the raw feed by pressure sampling',
    [],
    () => [[none, state().feedSampledOut]],
  );

  // ---- Latency inside the server.
  gauge(
    registry,
    'ins_processing_delay_ms',
    'Arrival to processed, last 10 s',
    ['quantile'],
    () => {
      const d = state().delay;
      return [
        [{ quantile: '0.5' }, d.p50],
        [{ quantile: '0.95' }, d.p95],
        [{ quantile: '0.99' }, d.p99],
      ];
    },
  );
  const windowToPublish = new Histogram({
    name: 'ins_window_to_publish_seconds',
    help: 'From the end of a 1-second window (event time) to the frame carrying it leaving the server',
    buckets: [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 20],
    registers: [registry],
  });
  const mongoWrite = new Histogram({
    name: 'ins_mongo_write_seconds',
    help: 'Time of one MongoDB bulk write of closed minutes',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  mirrored(registry, 'ins_mongo_docs_written_total', 'Hour documents upserted', [], () => [
    [none, src.store.docs],
  ]);
  mirrored(registry, 'ins_mongo_write_errors_total', 'Failed MongoDB writes', [], () => [
    [none, src.store.errors],
  ]);

  // ---- Threads.
  const loop = new LoopDelay();
  const mainLoop = () => ({ p50: loop.percentile(50), p99: loop.percentile(99) });
  // A fresh window every 10 s, so the numbers are about now, not since start.
  const resetLoop = setInterval(() => loop.reset(), 10_000);
  resetLoop.unref();
  gauge(
    registry,
    'ins_event_loop_delay_ms',
    'Event-loop delay, last 10 s',
    ['thread', 'quantile'],
    () => {
      const m = mainLoop();
      return [
        [{ thread: 'main', quantile: '0.5' }, m.p50],
        [{ thread: 'main', quantile: '0.99' }, m.p99],
        [{ thread: 'ingest', quantile: '0.99' }, state().thread.loopDelayMs],
      ];
    },
  );
  gauge(registry, 'ins_ingest_heap_bytes', 'JavaScript heap of the ingest thread', [], () => [
    [none, state().thread.heapMb * 1048576],
  ]);
  mirrored(
    registry,
    'ins_ingest_thread_restarts_total',
    'Times the ingest thread was restarted',
    [],
    () => [[none, src.ingest.thread().restarts]],
  );

  // ---- Delivery.
  gauge(registry, 'ins_sockets', 'Connected sockets', ['namespace'], () =>
    Object.entries(src.sockets()).map(([namespace, n]) => [{ namespace }, n]),
  );
  mirrored(registry, 'ins_frames_total', 'Delta frames sent to rooms', [], () => [
    [none, src.broadcast.frames],
  ]);
  mirrored(registry, 'ins_deltas_total', 'Changes inside those frames', [], () => [
    [none, src.broadcast.deltas],
  ]);
  mirrored(registry, 'ins_packets_out_total', 'Packets written to clients', [], () => [
    [none, src.delivery.packets],
  ]);
  mirrored(registry, 'ins_bytes_out_total', 'Bytes written to clients', [], () => [
    [none, src.delivery.bytes],
  ]);
  mirrored(registry, 'ins_feed_batches_total', 'Raw-feed batches sent', [], () => [
    [none, src.delivery.feedBatches],
  ]);
  gauge(registry, 'ins_slow_clients', 'Clients on 2-second summaries now', [], () => [
    [none, src.slow.slowNow],
  ]);
  mirrored(registry, 'ins_slow_downgrades_total', 'Clients moved to summaries', [], () => [
    [none, src.slow.downgrades],
  ]);

  return {
    registry,
    mongoWrite,
    windowToPublish,
    mainLoop,
    stop: () => {
      clearInterval(resetLoop);
      loop.stop();
    },
  };
}
