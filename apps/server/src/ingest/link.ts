import { MessageChannel, Worker } from 'node:worker_threads';
import type {
  EventEnvelope,
  Incident,
  RadarEvent,
  ReplayScenario,
  ReplayStatus,
  Source,
} from '@ins/shared';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { AsnRange } from '../refdata/rir.ts';
import type { ProbeInfo } from '../refdata/probes.ts';
import { serveIngest, type IngestLookup } from './core.ts';
import type { Latest } from './index.ts';
import type { WindowResult } from './pipeline/pipeline.ts';
import type {
  Call,
  ConnectionRow,
  FromIngest,
  IngestBoot,
  IngestState,
  Port,
  ToIngest,
} from './protocol.ts';
import type { SourceCounters } from './stats.ts';

const CALL_TIMEOUT_MS = 10_000;
/** Resolved incidents stay readable by ID this long (as in the incident manager). */
const KEEP_RESOLVED_MS = 30 * 60_000;

export interface LinkOptions {
  config: Config;
  log: Logger;
  /** Run the ingest side in a worker thread (default) or in this thread (tests). */
  thread: boolean;
  /** Network names for incident text (null until known; looked up in the background). */
  nameOf?(asn: number): string | null;
  /** In-thread mode only: the lookup object itself, instead of copies sent over. */
  lookup?: IngestLookup;
}

const emptyState = (): IngestState => ({
  sources: {},
  connections: [],
  latest: { second: null, bgpMinute: null, atlasMinute: null },
  pipeline: { duplicates: 0, lateMinute: 0, future: 0, knownPrefixes: 0 },
  replay: {
    state: 'idle',
    scenario: null,
    speed: 1,
    clock: null,
    emitted: 0,
    run: 0,
    error: null,
    lossy: false,
    amplify: 1,
  },
  queue: {
    depth: 0,
    capacity: 0,
    fill: 0,
    pressure: 'normal',
    sampleEvery: 1,
    oldestMs: 0,
    waitMaxMs: 0,
    offered: 0,
    processed: 0,
    shed: {},
    shedTotal: 0,
    overflow: 0,
    pauses: 0,
    maxDepth: 0,
  },
  probes: [],
  thread: { rssMb: 0, heapMb: 0, loopDelayMs: 0 },
});

/**
 * The main thread's handle on the ingest side.
 *
 * Reads are synchronous: the ingest thread sends a state summary four times a
 * second, plus every closed window and every incident change, and this class
 * keeps the latest copy. Commands are messages; the few that need an answer
 * (replay controls, routing-table questions for the attack simulator) return
 * promises.
 *
 * In thread mode a crashed ingest thread is restarted after a second, and is
 * sent the reference data and scenario mask again.
 */
export class IngestLink {
  private readonly opts: LinkOptions;
  private port!: Port & { close?(): void };
  private worker: Worker | null = null;
  private stopInline: (() => void) | null = null;
  private stopping = false;
  private restarts = 0;
  /** Messages sent while a crashed thread is being replaced; delivered to the new one. */
  private held: ToIngest[] | null = null;

  private state: IngestState = emptyState();
  private nextCall = 1;
  private readonly calls = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >();
  private readonly secondListeners: ((w: WindowResult) => void)[] = [];
  private readonly minuteListeners: ((w: WindowResult) => void)[] = [];
  private readonly incidentListeners: ((i: Incident) => void)[] = [];
  private readonly incidentMirror = new Map<string, Incident>();
  private readonly nameTimers = new Set<NodeJS.Timeout>();

  /** What to send a restarted thread so it picks up where the last one was. */
  private sent: { ranges?: AsnRange[]; probes?: ProbeInfo[]; masked: number[] | null } = {
    masked: null,
  };

  /** Latest latency per Atlas probe, and which changed since the publisher last looked. */
  readonly probeLatest = new Map<number, { ts: number; rtt: number | null }>();
  readonly probesChanged = new Set<number>();

  /** Running totals per source, as IngestStats offers them in the ingest thread. */
  readonly stats = {
    sources: (): Source[] => Object.keys(this.state.sources) as Source[],
    of: (source: Source): SourceCounters =>
      this.state.sources[source] ?? {
        messages: 0,
        events: 0,
        rejected: 0,
        warnings: 0,
        lagSumMs: 0,
        lagCount: 0,
      },
  };

  /** Incidents as the ingest thread last described them. */
  readonly incidents = {
    /** Open or resolving, newest first. */
    active: (): Incident[] =>
      [...this.incidentMirror.values()]
        .filter((i) => i.state !== 'resolved')
        .sort((a, b) => b.openedAt - a.openedAt),
    get: (id: string): Incident | undefined => this.incidentMirror.get(id),
  };

  constructor(opts: LinkOptions) {
    this.opts = opts;
    this.open();
  }

  private open(): void {
    const { config, log } = this.opts;
    if (this.opts.thread) {
      // Under `node file.ts` the worker is the .ts file; in the build it is worker.js.
      const file = import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js';
      const boot: IngestBoot = { config };
      const worker = new Worker(new URL(file, import.meta.url), { workerData: boot });
      this.worker = worker;
      this.port = worker;
      worker.on('error', (err) => log.error({ err }, 'ingest thread crashed'));
      worker.on('exit', (code) => {
        if (this.stopping) return;
        log.error({ code }, 'ingest thread exited; restarting in 1 s');
        // Calls the dead thread never answered fail now; new messages wait for the new thread.
        this.failCalls('ingest thread exited');
        this.held = [];
        this.restarts += 1;
        setTimeout(() => {
          if (this.stopping) return;
          const waiting = this.held ?? [];
          this.held = null;
          this.open();
          this.resend();
          for (const m of waiting) this.post(m);
        }, 1000).unref();
      });
    } else {
      const { port1, port2 } = new MessageChannel();
      this.port = port1;
      const stop = serveIngest(port2, {
        config,
        log,
        ...(this.opts.lookup && { lookup: this.opts.lookup }),
      });
      // Message ports would otherwise keep the process alive on their own.
      port1.unref();
      port2.unref();
      this.stopInline = () => {
        stop();
        port2.close();
      };
    }
    this.port.on('message', (m: FromIngest) => this.receive(m));
  }

  private resend(): void {
    const { ranges, probes, masked } = this.sent;
    if (ranges || probes)
      this.post({ t: 'refdata', ...(ranges && { ranges }), ...(probes && { probes }) });
    if (masked) this.post({ t: 'masked', asns: masked });
  }

  private post(message: ToIngest): void {
    if (this.held) {
      // Keep control messages and calls; at most a few seconds of scenario events.
      if (message.t !== 'events' || this.held.length < 1000) this.held.push(message);
      return;
    }
    this.port.postMessage(message);
  }

  private receive(m: FromIngest): void {
    switch (m.t) {
      case 'state':
        this.state = m.state;
        for (const [id, ts, rtt] of m.state.probes) {
          this.probeLatest.set(id, { ts, rtt });
          this.probesChanged.add(id);
        }
        break;
      case 'second':
        for (const l of this.secondListeners) l(m.window);
        break;
      case 'minute':
        for (const l of this.minuteListeners) l(m.window);
        break;
      case 'incident': {
        this.incidentMirror.set(m.incident.id, m.incident);
        const cutoff = Date.now() - KEEP_RESOLVED_MS;
        for (const [id, i] of this.incidentMirror) {
          if (i.state === 'resolved' && (i.resolvedAt ?? 0) < cutoff)
            this.incidentMirror.delete(id);
        }
        for (const l of this.incidentListeners) l(m.incident);
        break;
      }
      case 'needName':
        this.lookUpName(m.asn);
        break;
      case 'reply': {
        const call = this.calls.get(m.id);
        if (!call) return;
        this.calls.delete(m.id);
        clearTimeout(call.timer);
        if (m.ok) call.resolve(m.value);
        else call.reject(new Error(m.error));
        break;
      }
      case 'ready':
        this.opts.log.info({ thread: this.opts.thread }, 'ingest side ready');
        break;
    }
  }

  /** Names are fetched in the background; try a few times until one is known. */
  private lookUpName(asn: number, attempt = 0): void {
    const name = this.opts.nameOf?.(asn) ?? null;
    if (name) {
      this.post({ t: 'name', asn, name });
      return;
    }
    if (attempt >= 5 || !this.opts.nameOf) return;
    const timer = setTimeout(
      () => {
        this.nameTimers.delete(timer);
        this.lookUpName(asn, attempt + 1);
      },
      1000 * 2 ** attempt,
    );
    timer.unref();
    this.nameTimers.add(timer);
  }

  private call<T>(call: Call): Promise<T> {
    const id = this.nextCall++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`ingest call ${call.op} timed out`));
      }, CALL_TIMEOUT_MS);
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.post({ t: 'call', id, call });
    });
  }

  private failCalls(reason: string): void {
    for (const [id, call] of this.calls) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
      this.calls.delete(id);
    }
  }

  // ---- reads (synchronous, from the latest state)

  get latest(): Latest {
    return this.state.latest;
  }

  connections(): ConnectionRow[] {
    return this.state.connections;
  }

  pipelineSnapshot(): IngestState['pipeline'] {
    return this.state.pipeline;
  }

  replayStatus(): ReplayStatus {
    return this.state.replay;
  }

  queue(): IngestState['queue'] {
    return this.state.queue;
  }

  thread(): IngestState['thread'] & { mode: 'worker' | 'inline'; restarts: number } {
    return {
      ...this.state.thread,
      mode: this.opts.thread ? 'worker' : 'inline',
      restarts: this.restarts,
    };
  }

  onSecond(listener: (w: WindowResult) => void): void {
    this.secondListeners.push(listener);
  }

  onMinute(listener: (w: WindowResult) => void): void {
    this.minuteListeners.push(listener);
  }

  onIncident(listener: (i: Incident) => void): void {
    this.incidentListeners.push(listener);
  }

  // ---- commands

  /** Push events through the pipeline (scenario runs). */
  ingest(source: Source, batch: EventEnvelope[], now: number): void {
    this.post({ t: 'events', source, batch, now });
  }

  setMasked(asns: number[] | null): void {
    this.sent.masked = asns;
    this.post({ t: 'masked', asns });
  }

  setRefdata(update: { ranges?: AsnRange[]; probes?: ProbeInfo[] }): void {
    if (update.ranges) this.sent.ranges = update.ranges;
    if (update.probes) this.sent.probes = update.probes;
    this.post({ t: 'refdata', ...update });
  }

  warmStart(covered: number[], wd: Map<string, Map<number, number>>): void {
    this.post({ t: 'warmStart', covered, wd });
  }

  observeRadar(events: RadarEvent[]): void {
    this.post({ t: 'radar', events });
  }

  readonly replay = {
    status: () => this.call<ReplayStatus>({ op: 'replay', action: 'status' }),
    start: (scenario: ReplayScenario, speed: number, from: number, lossy = false, amplify = 1) =>
      this.call<ReplayStatus>({
        op: 'replay',
        action: 'start',
        scenario,
        speed,
        from,
        lossy,
        amplify,
      }),
    pause: () => this.call<ReplayStatus>({ op: 'replay', action: 'pause' }),
    resume: () => this.call<ReplayStatus>({ op: 'replay', action: 'resume' }),
    stop: () => this.call<ReplayStatus>({ op: 'replay', action: 'stop' }),
    setSpeed: (speed: number) => this.call<ReplayStatus>({ op: 'replay', action: 'speed', speed }),
  };

  prefixesOf(asn: number, limit: number): Promise<string[]> {
    return this.call({ op: 'prefixesOf', asn, limit });
  }

  largestIn(cc: string, n: number): Promise<number[]> {
    return this.call({ op: 'largestIn', cc, n });
  }

  /** Stop the feeds and timers, then the thread. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.nameTimers) clearTimeout(t);
    if (this.worker) {
      if (!this.held) await this.call({ op: 'stop' }).catch(() => {});
      await this.worker.terminate();
    } else {
      this.stopInline?.();
      this.port.close?.();
    }
    this.failCalls('ingest stopped');
  }
}
