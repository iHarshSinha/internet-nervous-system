import type { EventEnvelope } from '@ins/shared';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { createAtlasSource } from './sources/atlas.ts';
import { createRisSource } from './sources/ris.ts';
import type { UpstreamSocket } from './sources/upstream-socket.ts';
import { IngestStats } from './stats.ts';

export interface Ingest {
  stats: IngestStats;
  /** One entry per upstream connection, for the status endpoint. */
  connections(): { name: string; connected: boolean; reconnects: number; messages: number }[];
  stop(): void;
}

/**
 * Start the live sources. Every event they produce goes to `sink`, which is
 * where the pipeline (dedupe, windows, detection) attaches in the next step.
 */
export function startIngest(
  config: Config,
  log: Logger,
  sink: (events: EventEnvelope[]) => void,
): Ingest {
  const stats = new IngestStats();
  const sockets: UpstreamSocket[] = [];

  // In replay mode the recorded file is the only source; the live feeds stay off.
  if (config.MODE === 'live' && config.INGEST) {
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
    connections: () =>
      sockets.map((s) => ({
        name: s.name,
        connected: s.stats.connected,
        reconnects: s.stats.reconnects,
        messages: s.stats.messages,
      })),
    stop: () => {
      for (const socket of sockets) socket.stop();
    },
  };
}
