import { loadConfig } from './config.ts';
import { createMongo } from './db/client.ts';
import { createMetricsStore } from './db/metrics.ts';
import { createGoogleVerifier } from './auth/google.ts';
import { createMongoAuthStore } from './auth/store.ts';
import { createMongoRunsStore } from './scenarios/runs.ts';
import { createMongoIncidentStore } from './db/incidents.ts';
import { createMongoRadarStore } from './db/radar.ts';
import { createMongoIngestStatsStore } from './db/ingestStats.ts';
import { AsnNames } from './ingest/detect/names.ts';
import { createLogger } from './logger.ts';
import { RefData, startRefdata } from './refdata/index.ts';
import { buildServer } from './server.ts';

const config = loadConfig();
const log = createLogger(config);
const mongo = createMongo(config.MONGODB_URI);
const store = createMetricsStore(mongo.db, config.METRICS_ASN_LIMIT);
const refdata = new RefData();
const authStore = createMongoAuthStore(mongo.db);
const incidentStore = createMongoIncidentStore(mongo.db);
const radarStore = createMongoRadarStore(mongo.db);
const ingestStatsStore = createMongoIngestStatsStore(mongo.db);
const names = new AsnNames(mongo.db, log);
const server = buildServer({
  config,
  log,
  mongo,
  store,
  authStore,
  runsStore: createMongoRunsStore(mongo.db),
  incidentStore,
  radarStore,
  ingestStatsStore,
  nameOf: (asn) => names.get(asn),
  // Sign-in is switched on only when a Google client ID is configured.
  verifyGoogle: config.GOOGLE_CLIENT_ID ? createGoogleVerifier(config.GOOGLE_CLIENT_ID) : null,
  lookup: refdata,
  extraStatus: () => ({ refdata: refdata.stats() }),
});

if (!config.GOOGLE_CLIENT_ID) {
  log.warn('GOOGLE_CLIENT_ID not set: sign-in is off, the app is visitor-only');
}
if (config.JWT_SECRET_GENERATED) {
  log.warn('JWT_SECRET not set: using a random one, so sessions end when the server restarts');
}

// Indexes first (they guarantee one bucket per scope per hour), then reference data.
void Promise.all([
  store.ensureIndexes(),
  authStore.ensureIndexes(),
  incidentStore.ensureIndexes(),
  radarStore.ensureIndexes(),
  ingestStatsStore.ensureIndexes(),
])
  .then(() => incidentStore.closeOrphans(Date.now()))
  .then((closed) => closed > 0 && log.info({ closed }, 'closed incidents left open by a restart'))
  .then(() => log.info('indexes ready'))
  .catch((err: unknown) => log.error({ err }, 'could not create indexes'));
const stopRefdata = config.REFDATA ? startRefdata(mongo.db, refdata, log) : () => {};

server.http.listen(config.PORT, () => {
  log.info({ port: config.PORT, mode: config.MODE }, 'server listening');
});

// Report the database state once at startup; /readyz keeps reporting it afterwards.
void mongo.ping().then((ok) => {
  if (ok) log.info('mongodb reachable');
  else log.warn('mongodb not reachable yet; the driver keeps retrying');
});

// Docker sends SIGTERM on stop. Close cleanly so clients reconnect promptly.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    stopRefdata();
    server
      .close()
      .catch((err: unknown) => log.error({ err }, 'error during shutdown'))
      .finally(() => process.exit(0));
  });
}
