import type {
  EventEnvelope,
  Incident,
  RadarEvent,
  ReplayScenario,
  ReplayStatus,
  Source,
} from '@ins/shared';
import type { Config } from '../config.ts';
import type { AsnRange } from '../refdata/rir.ts';
import type { ProbeInfo } from '../refdata/probes.ts';
import type { Latest } from './index.ts';
import type { WindowResult } from './pipeline/pipeline.ts';
import type { QueueSnapshot } from './pipeline/queue.ts';
import type { SourceCounters } from './stats.ts';

/*
 * The messages between the main thread (Express, Socket.IO) and the ingest
 * thread (upstream feeds, pipeline, detectors). Both sides import these
 * types, so a change to one side that the other does not expect fails the
 * type check.
 *
 * Everything crosses as a structured clone (Maps and Sets included), so a
 * message is a copy: neither side can change the other's state.
 */

/** Upstream connection health, one row per connection. */
export interface ConnectionRow {
  name: string;
  connected: boolean;
  reconnects: number;
  messages: number;
}

/** Everything the main thread reads often, sent by the ingest thread four times a second. */
export interface IngestState {
  sources: Partial<Record<Source, SourceCounters>>;
  connections: ConnectionRow[];
  latest: Latest;
  /** Pipeline counters, dedupe size, open windows, collector skew. */
  pipeline: Record<string, unknown> & {
    duplicates: number;
    lateMinute: number;
    future: number;
    knownPrefixes: number;
  };
  replay: ReplayStatus;
  /** The bounded queue in front of the pipeline: depth, pressure, what was shed. */
  queue: QueueSnapshot;
  /** Probes whose latest latency changed since the last state: [id, ts, rtt]. */
  probes: [number, number, number | null][];
  /** Ingest thread health. RSS is the whole process; the heap is this thread's own. */
  thread: { rssMb: number; heapMb: number; loopDelayMs: number };
}

/** Requests that expect an answer. */
export type Call =
  | {
      op: 'replay';
      action: 'start';
      scenario: ReplayScenario;
      speed: number;
      from: number;
      lossy: boolean;
      amplify: number;
    }
  | { op: 'replay'; action: 'pause' | 'resume' | 'stop' | 'status' }
  | { op: 'replay'; action: 'speed'; speed: number }
  | { op: 'prefixesOf'; asn: number; limit: number }
  | { op: 'largestIn'; cc: string; n: number }
  | { op: 'stop' };

/** Main thread -> ingest thread. */
export type ToIngest =
  /** Events to push through the pipeline (scenario runs injected by admins). */
  | { t: 'events'; source: Source; batch: EventEnvelope[]; now: number }
  /** Networks a running scenario simulates; null when no scenario runs. */
  | { t: 'masked'; asns: number[] | null }
  /** Reference data for the ingest thread's own lookup copy. */
  | { t: 'refdata'; ranges?: AsnRange[]; probes?: ProbeInfo[] }
  /** Detector baselines from MongoDB, so a restart does not forget what "normal" was. */
  | { t: 'warmStart'; covered: number[]; wd: Map<string, Map<number, number>> }
  | { t: 'radar'; events: RadarEvent[] }
  /** A network name the ingest thread asked for (null: still unknown). */
  | { t: 'name'; asn: number; name: string }
  | { t: 'call'; id: number; call: Call };

/** Ingest thread -> main thread. */
export type FromIngest =
  | { t: 'ready' }
  | { t: 'state'; state: IngestState }
  | { t: 'second'; window: WindowResult }
  | { t: 'minute'; window: WindowResult }
  | { t: 'incident'; incident: Incident }
  /** The incident text needs a network's name. */
  | { t: 'needName'; asn: number }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string };

/** What the ingest thread is started with. */
export interface IngestBoot {
  /** The validated config (plain values, so it clones). */
  config: Config;
}

/** The part of a MessagePort (or a worker's parentPort) that both sides use. */
export interface Port {
  postMessage(message: unknown): void;
  // Matches Node's own typing of MessagePort and Worker (message values are `any` there).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (message: any) => void): unknown;
}
