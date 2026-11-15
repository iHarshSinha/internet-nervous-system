import type { EventEnvelope, Incident } from '@ins/shared';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { Detectors } from './detect/detectors.ts';
import { IncidentManager } from './detect/incidents.ts';
import type { Totals } from './pipeline/aggregate.ts';
import {
  Pipeline,
  type EventContext,
  type Lookup,
  type WindowResult,
} from './pipeline/pipeline.ts';
import { IngestQueue } from './pipeline/queue.ts';
import { createAtlasSource } from './sources/atlas.ts';
import { ReplayPlayer } from './sources/replay.ts';
import { createRisSource } from './sources/ris.ts';
import type { UpstreamSocket } from './sources/upstream-socket.ts';
import { IngestStats } from './stats.ts';

/** The most recent closed windows for the whole world, for the live frame and status. */
export interface Latest {
  /**
   * The newest COMPLETE 1-second routing window: every connected collector
   * has delivered past it, and late events have been added. While one
   * collector lags this is a few seconds older than the newest closed
   * window, but it is not an undercount.
   */
  second: { start: number; world: Totals; countries: number } | null;
  /** Last closed 1-minute windows, one per feed family. */
  bgpMinute: { start: number; world: Totals; scopes: number } | null;
  atlasMinute: { start: number; world: Totals } | null;
}

export interface Ingest {
  stats: IngestStats;
  pipeline: Pipeline;
  /** The bounded queue in front of the pipeline (every source goes through it). */
  queue: IngestQueue;
  /** Plays recorded incidents through the pipeline (admin-controlled). */
  replay: ReplayPlayer;
  latest: Latest;
  /** Live and recent incidents, raised by the detectors. */
  incidents: IncidentManager;
  detectors: Detectors;
  /** Register a listener for every deduplicated event, with its country and network. */
  onEvent(listener: (event: EventEnvelope, ctx: EventContext) => void): void;
  /** Register a listener for every incident that opens or changes. */
  onIncident(listener: (incident: Incident) => void): void;
  /** One entry per upstream connection, for the status endpoint. */
  connections(): { name: string; connected: boolean; reconnects: number; messages: number }[];
  /** Register a listener for every closed 1-second routing window (live view). */
  onSecond(listener: (window: WindowResult) => void): void;
  /** Register a listener for every closed 1-minute window (storage, detection). */
  onMinute(listener: (window: WindowResult) => void): void;
  stop(): void;
}

/**
 * Start the live sources and the pipeline that processes their events:
 *
 *   sources -> validate -> normalise -> queue -> [pipeline: dedupe -> windows -> totals]
 */
export interface DetectionDeps {
  /** Network names for incident text (looked up in the background). */
  nameOf?(asn: number): string | null;
  /** Connected Atlas probes in a country. */
  connectedProbes?(cc: string): number;
  /** Networks a running scenario is simulating (live updates for them are kept out). */
  isMasked?(asn: number): boolean;
}

export function startIngest(
  config: Config,
  log: Logger,
  lookup?: Lookup,
  detection: DetectionDeps = {},
): Ingest {
  const stats = new IngestStats();
  const sockets: UpstreamSocket[] = [];
  const latest: Latest = { second: null, bgpMinute: null, atlasMinute: null };
  const minuteListeners: ((window: WindowResult) => void)[] = [];
  const secondListeners: ((window: WindowResult) => void)[] = [];
  const incidentListeners: ((incident: Incident) => void)[] = [];
  const eventListeners: ((event: EventEnvelope, ctx: EventContext) => void)[] = [];
  // Assigned right after the pipeline exists (the detectors read its origin table).
  let detectors: Detectors | null = null;

  // Recent world seconds, kept up to date by corrections, to pick the newest complete one.
  type SecondPoint = { start: number; world: Totals; countries: number };
  const worldSeconds = new Map<number, SecondPoint>();
  const refreshLatest = () => {
    const complete = pipeline.secondsComplete;
    let best: SecondPoint | null = null;
    let newest: SecondPoint | null = null;
    for (const s of worldSeconds.values()) {
      if (!newest || s.start > newest.start) newest = s;
      if (s.start + 1000 <= complete && (!best || s.start > best.start)) best = s;
    }
    latest.second = best ?? newest;
  };

  const pipeline = new Pipeline({
    ...(lookup && { lookup }),
    onEvent: (event, ctx) => {
      detectors?.observe(event, ctx, Date.now());
      for (const listener of eventListeners) listener(event, ctx);
    },
    isMasked: (asn) => detection.isMasked?.(asn) ?? false,
    onSecond: (window) => {
      const world = window.scopes.get('world');
      if (world) {
        let countries = 0;
        for (const scope of window.scopes.keys()) if (scope.startsWith('country:')) countries += 1;
        // A correction carries only the countries it changed; keep the larger count.
        const before = worldSeconds.get(window.start)?.countries ?? 0;
        worldSeconds.set(window.start, {
          start: window.start,
          world,
          countries: Math.max(before, countries),
        });
        for (const start of worldSeconds.keys()) {
          if (start < window.start - 180_000) worldSeconds.delete(start);
        }
        refreshLatest();
      }
      for (const listener of secondListeners) listener(window);
    },
    onMinute: (window) => {
      // A correction of an older minute: storage and charts take it (listeners below),
      // but it is not "the latest minute" and the detectors have seen the current one.
      if (window.amended) {
        for (const listener of minuteListeners) listener(window);
        return;
      }
      const world = window.scopes.get('world');
      if (world) {
        if (window.family === 'bgp') {
          latest.bgpMinute = { start: window.start, world, scopes: window.scopes.size };
        } else {
          latest.atlasMinute = { start: window.start, world };
        }
      }
      log.debug(
        {
          family: window.family,
          start: new Date(window.start).toISOString(),
          scopes: window.scopes.size,
        },
        'minute window closed',
      );
      if (window.family === 'bgp') detectors?.onMinute(window.scopes);
      for (const listener of minuteListeners) listener(window);
    },
  });

  // Between the sources and the pipeline: bounded, with sampling and shedding.
  const queue = new IngestQueue({
    capacity: config.INGEST_QUEUE_MAX,
    process: (batch) => pipeline.ingest(batch, Date.now()),
  });

  // Anomaly detection: detectors -> signals -> incidents.
  detectors = new Detectors({
    origins: pipeline.origins,
    connectedProbes: (cc) => detection.connectedProbes?.(cc) ?? 0,
  });
  const incidents = new IncidentManager({
    nameOf: (asn) => detection.nameOf?.(asn) ?? null,
    countryOf: (asn) => lookup?.asnCountry(asn),
    onChange: (incident) => {
      for (const listener of incidentListeners) listener(incident);
    },
  });
  const detectTimer = setInterval(() => {
    const now = Date.now();
    incidents.report(detectors!.evaluate(now), now);
    incidents.tick(now);
  }, 1000);

  // Recorded incidents, retimed to now and fed through the same pipeline.
  const replay = new ReplayPlayer({
    files: { 'facebook-2021': config.REPLAY_FACEBOOK_FILE },
    log,
    sink: (batch, now, lossy) => {
      stats.accepted('replay', batch.length, batch[0]!.ts, now);
      // A file can wait for the pipeline (backpressure); a lossy run sheds like a live feed.
      if (lossy) queue.offer(batch);
      else return queue.offerAndWait(batch);
    },
  });

  // Windows close when the watermark passes them; check four times a second.
  const ticker = setInterval(() => {
    pipeline.tick(Date.now());
    refreshLatest();
  }, 250);

  // In replay mode the recorded file is the only source; the live feeds stay off.
  if (config.MODE === 'live' && config.INGEST) {
    const sink = (batch: Parameters<Pipeline['ingest']>[0]) => queue.offer(batch);
    sockets.push(
      ...createRisSource({
        clientName: config.RIS_CLIENT_NAME,
        collectors: config.RIS_COLLECTORS,
        ...(config.RIS_URL && { url: config.RIS_URL }),
        stats,
        log,
        sink,
      }),
      createAtlasSource({
        measurements: config.ATLAS_MEASUREMENTS,
        ...(config.ATLAS_URL && { url: config.ATLAS_URL }),
        stats,
        log,
        sink,
      }),
    );
    for (const socket of sockets) socket.start();
    log.info({ connections: sockets.map((s) => s.name) }, 'ingest started');
  } else {
    log.info({ mode: config.MODE, ingest: config.INGEST }, 'live ingest is off');
  }

  return {
    stats,
    pipeline,
    queue,
    replay,
    latest,
    incidents,
    detectors,
    onIncident: (listener) => incidentListeners.push(listener),
    onEvent: (listener) => eventListeners.push(listener),
    connections: () =>
      sockets.map((s) => ({
        name: s.name,
        connected: s.stats.connected,
        reconnects: s.stats.reconnects,
        messages: s.stats.messages,
      })),
    onSecond: (listener) => secondListeners.push(listener),
    onMinute: (listener) => minuteListeners.push(listener),
    stop: () => {
      clearInterval(ticker);
      clearInterval(detectTimer);
      replay.stop();
      queue.stop();
      for (const socket of sockets) socket.stop();
    },
  };
}
