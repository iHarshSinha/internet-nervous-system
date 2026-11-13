import { createServer, type Server as HttpServer } from 'node:http';
import { rooms } from '@ins/shared';
import { Server } from 'socket.io';
import { createApp } from './api/app.ts';
import { adminRouter } from './api/admin.ts';
import { authRouter } from './api/auth.ts';
import { globeRouter } from './api/globe.ts';
import { historyRouter } from './api/history.ts';
import { meRouter } from './api/me.ts';
import type { GoogleVerifier } from './auth/google.ts';
import type { AuthStore } from './auth/store.ts';
import type { Config } from './config.ts';
import type { Mongo } from './db/client.ts';
import type { MetricsStore } from './db/metrics.ts';
import { startIngest } from './ingest/index.ts';
import type { Lookup } from './ingest/pipeline/pipeline.ts';
import { RecentSeconds } from './ingest/recent.ts';
import type { Logger } from './logger.ts';
import { Broadcaster } from './realtime/broadcaster.ts';
import { startHeartbeat } from './realtime/heartbeat.ts';
import { clientAddress, ConnectionLimiter } from './realtime/limits.ts';
import { attachLive, handleLive, type IoServer, type LiveNamespace } from './realtime/live.ts';
import { attachPrivate } from './realtime/private.ts';
import { startPublishing } from './realtime/publish.ts';
import { RoomSequencer } from './realtime/sequencer.ts';

export interface ServerDeps {
  config: Config;
  log: Logger;
  mongo: Mongo;
  /** Where closed 1-minute windows are stored and history is read from. */
  store: MetricsStore;
  /** Users, sessions and watchlists. */
  authStore: AuthStore;
  /** Checks Google ID tokens; null when sign-in is not configured. */
  verifyGoogle: GoogleVerifier | null;
  /** Network and probe locations (filled in by the reference data loader). */
  lookup?: Lookup & {
    allProbes?(): Iterable<{ id: number; lat?: number; lon?: number; cc?: string; status: string }>;
  };
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

  // Socket.IO needs the HTTP server and the app needs Socket.IO's numbers, so
  // those are read through a holder that is filled in once everything exists.
  const late: {
    live?: LiveNamespace;
    namespaces?: Record<string, LiveNamespace>;
    publisher?: ReturnType<typeof startPublishing>;
    broadcaster?: Broadcaster;
  } = {};

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

  const opsStats = () => ({
    pipeline: ingest.pipeline.snapshot(),
    sources: Object.fromEntries(ingest.stats.sources().map((s) => [s, ingest.stats.of(s)])),
    upstreams: ingest.connections(),
    sockets: Object.fromEntries(
      Object.entries(late.namespaces ?? {}).map(([name, ns]) => [name, ns.sockets.size]),
    ),
    broadcast: late.broadcaster?.stats,
    metrics: store.stats,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  });

  const app = createApp({
    config,
    log,
    mongo,
    ingest,
    liveSockets: () => late.live?.sockets.size ?? 0,
    routes: [
      authRouter({ config, log, store: deps.authStore, verifyGoogle: deps.verifyGoogle }),
      meRouter({ secret: config.JWT_SECRET, store: deps.authStore, adminStats: opsStats }),
      adminRouter({ secret: config.JWT_SECRET, replay: ingest.replay, log }),
      historyRouter({ store, recent, seq }),
      globeRouter({
        probes: () => deps.lookup?.allProbes?.() ?? [],
        pipeline: ingest.pipeline,
        publisher: { countries: () => late.publisher?.countries() ?? {}, stop: () => {} },
        seq,
      }),
    ],
    extraStatus: () => ({
      ...deps.extraStatus?.(),
      metrics: store.stats,
      broadcast: late.broadcaster?.stats,
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
  const { user, admin } = attachPrivate(io, config.JWT_SECRET, log);
  late.live = live;
  late.namespaces = { live, user, admin };

  // At most N new socket connections per client address per minute, across all namespaces.
  const connections = new ConnectionLimiter(config.SOCKET_CONNECTIONS_PER_MIN);
  for (const ns of [live, user, admin]) {
    ns.use((socket, next) => {
      const address = clientAddress(socket.handshake.headers, socket.handshake.address);
      if (connections.allow(address)) return next();
      log.warn({ address }, 'socket connection refused: too many from this address');
      next(new Error('rate_limited'));
    });
  }

  // Closed windows -> staged deltas -> one numbered frame per room every 500 ms.
  const opts = {
    ...(deps.conflateMs !== undefined && { conflateMs: deps.conflateMs }),
    ...(deps.ringSize !== undefined && { ringSize: deps.ringSize }),
  };
  const broadcaster = new Broadcaster(live, seq, opts);
  late.broadcaster = broadcaster;
  handleLive(live, seq, broadcaster, log, config.SOCKET_MESSAGES_PER_SEC);
  const publisher = startPublishing(ingest, broadcaster);
  late.publisher = publisher;
  broadcaster.start();
  const stopHeartbeat = startHeartbeat(live, broadcaster, ingest, heartbeatMs);

  // The admin-only `ops` room: pipeline and delivery numbers, once a second.
  const opsBroadcaster = new Broadcaster(admin, new RoomSequencer(), opts);
  opsBroadcaster.start();
  const opsTimer = setInterval(() => {
    const s = opsStats();
    const put = (key: string, field: string, value: number | null) =>
      opsBroadcaster.set(rooms.ops, key, field, value);
    put('proc', 'rssMb', s.memoryMb);
    for (const [name, count] of Object.entries(s.sockets)) put('sockets', name, count);
    for (const [k, v] of Object.entries(s.pipeline)) if (typeof v === 'number') put('pipe', k, v);
    put('broadcast', 'frames', broadcaster.stats.frames);
    put('broadcast', 'deltas', broadcaster.stats.deltas);
  }, heartbeatMs ?? 1000);

  return {
    http,
    io,
    broadcaster,
    async close() {
      clearInterval(opsTimer);
      opsBroadcaster.stop();
      stopHeartbeat();
      publisher.stop();
      broadcaster.stop();
      ingest.stop();
      await io.close(); // also closes the HTTP server
      await mongo.close();
    },
  };
}
