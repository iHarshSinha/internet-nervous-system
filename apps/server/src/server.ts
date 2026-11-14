import { createServer, type Server as HttpServer } from 'node:http';
import { rooms } from '@ins/shared';
import { Router } from 'express';
import { Server } from 'socket.io';
import msgpackParser from 'socket.io-msgpack-parser';
import { createApp } from './api/app.ts';
import { adminRouter } from './api/admin.ts';
import { authRouter } from './api/auth.ts';
import { globeRouter } from './api/globe.ts';
import { historyRouter } from './api/history.ts';
import { incidentsRouter } from './api/incidents.ts';
import type { IncidentStore } from './db/incidents.ts';
import { createMemoryRadarStore, type RadarStore } from './db/radar.ts';
import { radarRouter } from './api/radar.ts';
import { RadarPoller } from './ingest/sources/radar.ts';
import { meRouter } from './api/me.ts';
import type { GoogleVerifier } from './auth/google.ts';
import type { AuthStore } from './auth/store.ts';
import type { Config } from './config.ts';
import type { Mongo } from './db/client.ts';
import type { MetricsStore } from './db/metrics.ts';
import type { IngestLookup } from './ingest/core.ts';
import { IngestLink } from './ingest/link.ts';
import type { RefDataUpdate } from './refdata/index.ts';
import { RecentSeconds } from './ingest/recent.ts';
import type { Logger } from './logger.ts';
import { Broadcaster } from './realtime/broadcaster.ts';
import { startHeartbeat } from './realtime/heartbeat.ts';
import { clientAddress, ConnectionLimiter } from './realtime/limits.ts';
import { attachLive, handleLive, type IoServer, type LiveNamespace } from './realtime/live.ts';
import { attachPrivate } from './realtime/private.ts';
import { startPublishing } from './realtime/publish.ts';
import { RoomSequencer } from './realtime/sequencer.ts';
import { SlowClients, type backlogOf } from './realtime/slow.ts';
import { fetchAnnouncedPrefixes } from './scenarios/prefixes.ts';
import { ScenarioRunner } from './scenarios/runner.ts';
import type { RunsStore } from './scenarios/runs.ts';
import {
  EV,
  incidentKey,
  LIMITS,
  PAIRS_KEY,
  type AttackPair,
  type Incident,
  type RealtimeConfig,
} from '@ins/shared';

export interface ServerDeps {
  config: Config;
  log: Logger;
  mongo: Mongo;
  /** Where closed 1-minute windows are stored and history is read from. */
  store: MetricsStore;
  /** Users, sessions and watchlists. */
  authStore: AuthStore;
  /** Where incidents are kept. */
  incidentStore: IncidentStore;
  /** Cloudflare Radar events (memory when not given, as in tests). */
  radarStore?: RadarStore;
  /** Network names for incident text; null names until looked up. */
  nameOf?(asn: number): string | null;
  /** Records of scenario runs (simulated stretches of time). */
  runsStore: RunsStore;
  /** Checks Google ID tokens; null when sign-in is not configured. */
  verifyGoogle: GoogleVerifier | null;
  /** Network and probe locations (filled in by the reference data loader). */
  lookup?: IngestLookup & {
    /** Changes to the reference data, forwarded to the ingest thread's own copy. */
    subscribe?(listener: (update: RefDataUpdate) => void): void;
  };
  /** Extra numbers for /api/status, such as reference data counts. */
  extraStatus?: () => Record<string, unknown>;
  /** Tests shorten these so they do not wait whole seconds. */
  heartbeatMs?: number;
  conflateMs?: number;
  ringSize?: number;
  slowSummaryMs?: number;
  slowCheckMs?: number;
  /** Tests stand in for a real socket's send backlog. */
  backlog?: typeof backlogOf;
}

export interface RunningServer {
  http: HttpServer;
  io: IoServer;
  broadcaster: Broadcaster;
  slow: SlowClients;
  /** The ingest side (worker thread or in-thread), for tests and tools. */
  ingest: IngestLink;
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
    userBroadcaster?: Broadcaster;
    slow?: SlowClients;
  } = {};

  /*
   * The live sources, the pipeline and the detectors run on the other side of
   * this link: in their own worker thread unless INGEST_THREAD=off. This
   * thread receives closed windows and incidents, stores them and broadcasts.
   */
  const thread = config.INGEST_THREAD;
  const ingest = new IngestLink({
    config,
    log,
    thread,
    nameOf: (asn) => deps.nameOf?.(asn) ?? null,
    // In the same thread the lookup is shared; a worker gets copies as they change.
    ...(!thread && deps.lookup && { lookup: deps.lookup }),
  });
  if (thread) deps.lookup?.subscribe?.((update) => ingest.setRefdata(update));

  /*
   * Personal alerts: people whose watchlist covers the incident's country or
   * network hear about it on their private channel when it opens, when it gets
   * worse, and when it resolves, if it reaches the severity they chose.
   */
  const RANK = { watch: 0, warning: 1, critical: 2 } as const;
  const alerted = new Map<string, string>(); // incident id -> last state|severity alerted
  const alertWatchers = (incident: Incident, snapshot: Record<string, unknown>) => {
    const stage = incident.state === 'resolved' ? 'resolved' : incident.severity;
    const last = alerted.get(incident.id);
    if (last === stage || (last === 'critical' && stage === 'warning')) return;
    if (stage === 'resolved' && last === undefined) return;
    alerted.set(incident.id, stage);
    if (stage === 'resolved') setTimeout(() => alerted.delete(incident.id), 60_000).unref();
    deps.authStore
      .watchersOf(incident.cc, incident.asn)
      .then((watchers) => {
        for (const w of watchers) {
          if (RANK[incident.severity] < RANK[w.minSeverity]) continue;
          late.userBroadcaster?.set(rooms.user(w.userId), `alert:${incident.id}`, 'v', snapshot);
        }
      })
      .catch((err: unknown) => log.warn({ err }, 'could not look up watchers'));
  };

  // Every incident change is saved and sent to the rooms that show it.
  ingest.onIncident((incident) => {
    deps.incidentStore
      .save(incident)
      .catch((err: unknown) => log.error({ err }, 'could not save incident'));
    // Already a copy (it crossed from the ingest side); the frame format carries objects as records.
    const snapshot = incident as unknown as Record<string, unknown>;
    const key = incidentKey(incident.id);
    const b = late.broadcaster;
    if (!b) return;
    b.set(rooms.incidents, key, 'v', snapshot);
    if (incident.asn !== null) b.set(rooms.asn(incident.asn), key, 'v', snapshot);
    if (incident.cc) b.set(rooms.country(incident.cc), key, 'v', snapshot);
    alertWatchers(incident, snapshot);
    // Joiners are sent each room's current values; a long-resolved incident need not be one.
    if (incident.state === 'resolved') {
      setTimeout(() => {
        b.forget(rooms.incidents, key, 'v');
        if (incident.asn !== null) b.forget(rooms.asn(incident.asn), key, 'v');
        if (incident.cc) b.forget(rooms.country(incident.cc), key, 'v');
      }, 30 * 60_000).unref();
    }
    if (incident.state === 'open' && incident.updatedAt === incident.openedAt) {
      log.info(
        { incident: incident.id, scope: incident.scope, severity: incident.severity },
        'incident opened',
      );
    }
  });

  // Remember what "normal" looked like before a restart: the last hour of stored minutes.
  if (store.recentWithdrawals) {
    const to = Date.now() - (Date.now() % 60_000);
    store
      .recentWithdrawals(to - 60 * 60_000, to)
      .then(({ covered, wd }) => {
        ingest.warmStart(covered, wd);
        log.info({ minutes: covered.length, scopes: wd.size }, 'detector baselines loaded');
      })
      .catch((err: unknown) => log.warn({ err }, 'could not load detector baselines'));
  }

  /*
   * Cloudflare Radar (optional). Events go to the detectors (D6, confirmation)
   * and MongoDB; new ones and the attack pairs go to the `arcs` room.
   */
  const radarStore = deps.radarStore ?? createMemoryRadarStore();
  let radarPairs: { pairs: AttackPair[]; updatedAt: number | null } = {
    pairs: [],
    updatedAt: null,
  };
  const token = config.CLOUDFLARE_API_TOKEN;
  const radar = token
    ? new RadarPoller({
        token,
        log,
        eventsEveryMs: config.RADAR_EVENTS_EVERY_S * 1000,
        pairsEveryMs: config.RADAR_PAIRS_EVERY_S * 1000,
        onEvents: (events) => {
          ingest.observeRadar(events);
          radarStore
            .save(events)
            .then((fresh) => {
              for (const e of fresh) {
                late.broadcaster?.set(
                  rooms.arcs,
                  e.id,
                  'v',
                  structuredClone(e) as unknown as Record<string, unknown>,
                );
              }
              if (fresh.length > 0)
                log.info({ fresh: fresh.length }, 'new cloudflare radar events');
            })
            .catch((err: unknown) => log.warn({ err }, 'could not store radar events'));
        },
        onPairs: (pairs) => {
          radarPairs = { pairs, updatedAt: Date.now() };
          late.broadcaster?.set(rooms.arcs, PAIRS_KEY, 'v', structuredClone(pairs));
        },
      })
    : null;
  if (radar) {
    // What Radar reported before a restart still confirms incidents now.
    radarStore
      .recent(Date.now() - 7 * 24 * 3600_000, 500)
      .then((events) => ingest.observeRadar(events))
      .catch((err: unknown) => log.warn({ err }, 'could not load radar events'));
    radar.start();
  } else {
    log.info('CLOUDFLARE_API_TOKEN not set: the Cloudflare Radar layer is off');
  }

  // Recent 1-second points in memory; every closed minute goes to MongoDB.
  const recent = new RecentSeconds();
  ingest.onSecond((window) => recent.add(window));
  ingest.onMinute((window) => {
    store
      .writeMinute(window)
      .catch((err: unknown) => log.error({ err, family: window.family }, 'metrics write failed'));
  });

  // Admin-triggered scenarios: short, labelled bursts injected into the live stream.
  const runIds = new Map<number, Promise<string>>();
  const scenarios = new ScenarioRunner({
    log,
    sink: (batch, now) => ingest.ingest('replay', batch, now),
    onStart: (run, plan, startedAt) => {
      ingest.setMasked(plan.masked);
      const id = deps.runsStore.started(plan.id, startedAt, plan.asn, plan.cc);
      id.catch((err: unknown) => log.warn({ err }, 'could not record scenario run'));
      runIds.set(run, id);
    },
    onEnd: (run, endedAt) => {
      ingest.setMasked(null);
      void runIds
        .get(run)
        ?.then((id) => deps.runsStore.ended(id, endedAt))
        .catch((err: unknown) => log.warn({ err }, 'could not close scenario run'));
      runIds.delete(run);
    },
  });

  // Everything Engine.IO writes to clients, across namespaces: the bytes the optimisations save.
  const delivery = { packets: 0, bytes: 0, feedBatches: 0 };
  const realtimeConfig: RealtimeConfig = {
    parser: config.SOCKET_PARSER,
    conflateMs: deps.conflateMs ?? config.CONFLATE_MS,
    slowSummaryMs: deps.slowSummaryMs ?? LIMITS.slowClientSummaryMs,
    feedEventsPerSecond: LIMITS.feedEventsPerSecond,
  };
  // The browser asks which wire format to use before it connects.
  const realtimeRouter = Router().get('/api/realtime', (_req, res) => {
    res.json(realtimeConfig);
  });

  const opsStats = () => ({
    pipeline: ingest.pipelineSnapshot(),
    queue: ingest.queue(),
    ingestThread: ingest.thread(),
    sources: Object.fromEntries(ingest.stats.sources().map((s) => [s, ingest.stats.of(s)])),
    upstreams: ingest.connections(),
    sockets: Object.fromEntries(
      Object.entries(late.namespaces ?? {}).map(([name, ns]) => [name, ns.sockets.size]),
    ),
    broadcast: late.broadcaster?.stats,
    delivery: {
      ...delivery,
      slow: late.slow?.stats ?? null,
      feedSampledOut: ingest.feedSampledOut(),
    },
    metrics: store.stats,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    radar: radar?.stats ?? null,
  });

  const app = createApp({
    config,
    log,
    mongo,
    ingest,
    liveSockets: () => late.live?.sockets.size ?? 0,
    routes: [
      realtimeRouter,
      authRouter({ config, log, store: deps.authStore, verifyGoogle: deps.verifyGoogle }),
      meRouter({ secret: config.JWT_SECRET, store: deps.authStore, adminStats: opsStats }),
      adminRouter({
        secret: config.JWT_SECRET,
        replay: ingest.replay,
        scenarios,
        runs: deps.runsStore,
        scenarioDir: config.SCENARIO_DIR,
        attacks: {
          prefixesOf: (asn, limit) => ingest.prefixesOf(asn, limit),
          largestIn: (cc, n) => ingest.largestIn(cc, n),
          probesIn: (cc) =>
            [...(deps.lookup?.allProbes?.() ?? [])]
              .filter((p) => p.cc === cc && p.status === 'Connected')
              .map((p) => p.id),
          countryOf: (asn) => deps.lookup?.asnCountry(asn),
          fetchPrefixes: (asn) => fetchAnnouncedPrefixes(asn),
        },
        log,
      }),
      historyRouter({ store, recent, seq }),
      incidentsRouter({ manager: ingest.incidents, store: deps.incidentStore, seq }),
      radarRouter({ enabled: radar !== null, store: radarStore, pairs: () => radarPairs, seq }),
      globeRouter({
        probes: () => deps.lookup?.allProbes?.() ?? [],
        probeLatest: ingest.probeLatest,
        publisher: { countries: () => late.publisher?.countries() ?? {}, stop: () => {} },
        seq,
      }),
    ],
    extraStatus: () => ({
      ...deps.extraStatus?.(),
      metrics: store.stats,
      broadcast: late.broadcaster?.stats,
      delivery: {
        ...delivery,
        parser: config.SOCKET_PARSER,
        slow: late.slow?.stats ?? null,
        feedSampledOut: ingest.feedSampledOut(),
      },
      recentScopes: recent.scopes,
      ingestThread: ingest.thread(),
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
    // MessagePack: binary frames, smaller than JSON and with no field-name quoting.
    ...(config.SOCKET_PARSER === 'msgpack' && { parser: msgpackParser }),
  });
  // Count what Engine.IO writes to clients (all namespaces share one connection per client).
  io.engine.on(
    'connection',
    (conn: { on(e: string, l: (p: { data?: unknown }) => void): void }) => {
      conn.on('packetCreate', (packet) => {
        const data = packet.data;
        delivery.packets += 1;
        if (typeof data === 'string') delivery.bytes += Buffer.byteLength(data);
        else if (data instanceof Uint8Array) delivery.bytes += data.byteLength;
      });
    },
  );

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
    conflateMs: realtimeConfig.conflateMs,
    ...(deps.ringSize !== undefined && { ringSize: deps.ringSize }),
  };
  const broadcaster = new Broadcaster(live, seq, { ...opts, target: config.BROADCAST });
  late.broadcaster = broadcaster;

  // Slow clients get a merged frame every 2 s instead of every 500 ms (realtime/slow.ts).
  const slow = new SlowClients(live, broadcaster, seq, {
    log,
    summaryMs: realtimeConfig.slowSummaryMs,
    ...(deps.slowCheckMs !== undefined && { checkMs: deps.slowCheckMs }),
    ...(deps.backlog && { backlog: deps.backlog }),
  });
  late.slow = slow;
  if (config.SLOW_CLIENTS) slow.start();

  /*
   * Firehose. The ingest thread samples only for feed rooms that have
   * members, so it is told whenever one appears or empties. Batches go out
   * volatile: a client that is not ready to receive simply misses one.
   */
  const feedRooms = new Set<string>();
  const syncFeedRooms = () => ingest.setFeedRooms([...feedRooms]);
  live.adapter.on('create-room', (room: string) => {
    if (room.startsWith('feed:')) {
      feedRooms.add(room);
      syncFeedRooms();
    }
  });
  live.adapter.on('delete-room', (room: string) => {
    if (feedRooms.delete(room)) syncFeedRooms();
  });
  ingest.onFeed((batches) => {
    for (const batch of batches) {
      if (!feedRooms.has(batch.r)) continue;
      live.to(batch.r).volatile.emit(EV.feed, batch);
      delivery.feedBatches += 1;
    }
  });
  handleLive(live, seq, broadcaster, log, config.SOCKET_MESSAGES_PER_SEC);
  const publisher = startPublishing(ingest, broadcaster);
  late.publisher = publisher;
  broadcaster.start();
  const stopHeartbeat = startHeartbeat(live, broadcaster, ingest, heartbeatMs, () =>
    scenarios.snapshot(),
  );

  // The admin-only `ops` room: pipeline and delivery numbers, once a second.
  const opsBroadcaster = new Broadcaster(admin, new RoomSequencer(), opts);
  opsBroadcaster.start();
  // Personal alerts, in each user's own room of /user.
  const userBroadcaster = new Broadcaster(user, new RoomSequencer(), opts);
  late.userBroadcaster = userBroadcaster;
  userBroadcaster.start();
  const opsTimer = setInterval(() => {
    const s = opsStats();
    const put = (key: string, field: string, value: number | null) =>
      opsBroadcaster.set(rooms.ops, key, field, value);
    put('proc', 'rssMb', s.memoryMb);
    for (const [name, count] of Object.entries(s.sockets)) put('sockets', name, count);
    for (const [k, v] of Object.entries(s.pipeline)) if (typeof v === 'number') put('pipe', k, v);
    put('thread', 'heapMb', s.ingestThread.heapMb);
    put('thread', 'loopDelayMs', s.ingestThread.loopDelayMs);
    put('queue', 'depth', s.queue.depth);
    put('queue', 'fill', s.queue.fill);
    put('queue', 'sampleEvery', s.queue.sampleEvery);
    put('queue', 'waitMaxMs', s.queue.waitMaxMs);
    put('queue', 'shed', s.queue.shedTotal);
    put('queue', 'overflow', s.queue.overflow);
    put('broadcast', 'frames', broadcaster.stats.frames);
    put('broadcast', 'deltas', broadcaster.stats.deltas);
    put('delivery', 'packets', delivery.packets);
    put('delivery', 'bytes', delivery.bytes);
    put('delivery', 'slowNow', slow.stats.slowNow);
  }, heartbeatMs ?? 1000);

  return {
    http,
    io,
    broadcaster,
    slow,
    ingest,
    async close() {
      slow.stop();
      clearInterval(opsTimer);
      opsBroadcaster.stop();
      userBroadcaster.stop();
      stopHeartbeat();
      scenarios.stop();
      radar?.stop();
      publisher.stop();
      broadcaster.stop();
      await ingest.stop();
      await io.close(); // also closes the HTTP server
      await mongo.close();
    },
  };
}
