import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { Totals } from './pipeline/aggregate.ts';
import { Pipeline, type Lookup, type WindowResult } from './pipeline/pipeline.ts';
import { createAtlasSource } from './sources/atlas.ts';
import { ReplayPlayer } from './sources/replay.ts';
import { createRisSource } from './sources/ris.ts';
import type { UpstreamSocket } from './sources/upstream-socket.ts';
import { IngestStats } from './stats.ts';

/** The most recent closed windows for the whole world, for the live frame and status. */
export interface Latest {
  /** Last closed 1-second routing window. */
  second: { start: number; world: Totals; countries: number } | null;
  /** Last closed 1-minute windows, one per feed family. */
  bgpMinute: { start: number; world: Totals; scopes: number } | null;
  atlasMinute: { start: number; world: Totals } | null;
}

export interface Ingest {
  stats: IngestStats;
  pipeline: Pipeline;
  /** Plays recorded incidents through the pipeline (admin-controlled). */
  replay: ReplayPlayer;
  latest: Latest;
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
 *   sources -> validate -> normalise -> [pipeline: dedupe -> windows -> totals]
 */
export function startIngest(config: Config, log: Logger, lookup?: Lookup): Ingest {
  const stats = new IngestStats();
  const sockets: UpstreamSocket[] = [];
  const latest: Latest = { second: null, bgpMinute: null, atlasMinute: null };
  const minuteListeners: ((window: WindowResult) => void)[] = [];
  const secondListeners: ((window: WindowResult) => void)[] = [];

  const pipeline = new Pipeline({
    ...(lookup && { lookup }),
    onSecond: (window) => {
      const world = window.scopes.get('world');
      if (world) {
        let countries = 0;
        for (const scope of window.scopes.keys()) if (scope.startsWith('country:')) countries += 1;
        latest.second = { start: window.start, world, countries };
      }
      for (const listener of secondListeners) listener(window);
    },
    onMinute: (window) => {
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
      for (const listener of minuteListeners) listener(window);
    },
  });

  // Recorded incidents, retimed to now and fed through the same pipeline.
  const replay = new ReplayPlayer({
    files: { 'facebook-2021': config.REPLAY_FACEBOOK_FILE },
    log,
    sink: (batch, now) => {
      stats.accepted('replay', batch.length, batch[0]!.ts, now);
      pipeline.ingest(batch, now);
    },
  });

  // Windows close when the watermark passes them; check four times a second.
  const ticker = setInterval(() => pipeline.tick(Date.now()), 250);

  // In replay mode the recorded file is the only source; the live feeds stay off.
  if (config.MODE === 'live' && config.INGEST) {
    const sink = (batch: Parameters<Pipeline['ingest']>[0]) => pipeline.ingest(batch, Date.now());
    sockets.push(
      ...createRisSource({
        clientName: config.RIS_CLIENT_NAME,
        collectors: config.RIS_COLLECTORS,
        stats,
        log,
        sink,
      }),
      createAtlasSource({ measurements: config.ATLAS_MEASUREMENTS, stats, log, sink }),
    );
    for (const socket of sockets) socket.start();
    log.info({ connections: sockets.map((s) => s.name) }, 'ingest started');
  } else {
    log.info({ mode: config.MODE, ingest: config.INGEST }, 'live ingest is off');
  }

  return {
    stats,
    pipeline,
    replay,
    latest,
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
      replay.stop();
      for (const socket of sockets) socket.stop();
    },
  };
}
