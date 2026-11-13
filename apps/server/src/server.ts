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
import { Broadcaster } from './realtime/broadcaster.ts';
import { attachLive, handleLive, type IoServer } from './realtime/live.ts';
import { publishWindows } from './realtime/publish.ts';
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
  /** Tests shorten these so they do not wait whole seconds. */
  heartbeatMs?: number;
  conflateMs?: number;
  ringSize?: number;
}

export interface RunningServer {
  http: HttpServer;
  io: IoServer;
  broadcaster: Broadcaster;
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
      broadcast: broadcaster.stats,
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

  const live = attachLive(io);
  liveSockets = () => live.sockets.size;

  // Closed windows -> staged deltas -> one numbered frame per room every 500 ms.
  const broadcaster = new Broadcaster(live, seq, {
    ...(deps.conflateMs !== undefined && { conflateMs: deps.conflateMs }),
    ...(deps.ringSize !== undefined && { ringSize: deps.ringSize }),
  });
  handleLive(live, seq, broadcaster, log);
  publishWindows(ingest, broadcaster);
  broadcaster.start();
  const stopHeartbeat = startHeartbeat(live, broadcaster, ingest, heartbeatMs);

  return {
    http,
    io,
    broadcaster,
    async close() {
      stopHeartbeat();
      broadcaster.stop();
      ingest.stop();
      await io.close(); // also closes the HTTP server
      await mongo.close();
    },
  };
}
