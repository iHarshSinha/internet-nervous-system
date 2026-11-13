import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './api/app.ts';
import { historyRouter } from './api/history.ts';
import type { Config } from './config.ts';
import type { Mongo } from './db/client.ts';
import type { MetricsStore } from './db/metrics.ts';
import type { Lookup } from './ingest/pipeline/pipeline.ts';
import { RecentSeconds } from './ingest/recent.ts';
import { startIngest } from './ingest/index.ts';
import type { Logger } from './logger.ts';
import { startHeartbeat } from './realtime/heartbeat.ts';
import { attachLive, type IoServer } from './realtime/live.ts';
import { RoomSequencer } from './realtime/sequencer.ts';

export interface ServerDeps {
  config: Config;
  log: Logger;
  mongo: Mongo;
  /** Where closed 1-minute windows are stored and history is read from. */
  store: MetricsStore;
  /** Network and probe locations (filled in by the reference data loader). */
  lookup?: Lookup;
  /** Extra numbers for /api/status, such as reference data counts. */
  extraStatus?: () => Record<string, unknown>;
  /** Tests shorten this so they do not wait whole seconds. */
  heartbeatMs?: number;
}

export interface RunningServer {
  http: HttpServer;
  io: IoServer;
  /** Stop timers, disconnect sockets, close the HTTP server and the database. */
  close(): Promise<void>;
}

/** Wire Express and Socket.IO onto one HTTP server. Does not start listening. */
export function buildServer(deps: ServerDeps): RunningServer {
  const { config, log, mongo, store, heartbeatMs } = deps;
  const seq = new RoomSequencer();

  // The app needs the socket count and Socket.IO needs the HTTP server, so the
  // count is read through a function that is filled in once both exist.
  let liveSockets = () => 0;

  // The live sources and the pipeline that turns their events into windows.
  const ingest = startIngest(config, log, deps.lookup);

  // Recent 1-second points in memory; every closed minute goes to MongoDB.
  const recent = new RecentSeconds();
  ingest.onSecond((window) => recent.add(window));
  ingest.onMinute((window) => {
    store
      .writeMinute(window)
      .catch((err: unknown) => log.error({ err, family: window.family }, 'metrics write failed'));
  });

  const app = createApp({
    config,
    log,
    mongo,
    ingest,
    liveSockets: () => liveSockets(),
    routes: [historyRouter({ store, recent, seq })],
    extraStatus: () => ({
      ...deps.extraStatus?.(),
      metrics: store.stats,
      recentScopes: recent.scopes,
    }),
  });
  const http = createServer(app);

  const io: IoServer = new Server(http, {
    serveClient: false,
    // Clients only ever send small control messages (sub, unsub, resync).
    maxHttpBufferSize: 64 * 1024,
    // After a short network drop, Socket.IO restores the client's rooms and
    // re-sends the packets it missed. Our sequence numbers then verify it.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  });

  const live = attachLive(io, seq, log);
  liveSockets = () => live.sockets.size;
  const stopHeartbeat = startHeartbeat(live, seq, ingest, heartbeatMs);

  return {
    http,
    io,
    async close() {
      stopHeartbeat();
      ingest.stop();
      await io.close(); // also closes the HTTP server
      await mongo.close();
    },
  };
}
