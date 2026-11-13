import { loadConfig } from './config.ts';
import { createMongo } from './db/client.ts';
import { createMetricsStore } from './db/metrics.ts';
import { createLogger } from './logger.ts';
import { RefData, startRefdata } from './refdata/index.ts';
import { buildServer } from './server.ts';

const config = loadConfig();
const log = createLogger(config);
const mongo = createMongo(config.MONGODB_URI);
const store = createMetricsStore(mongo.db, config.METRICS_ASN_LIMIT);
const refdata = new RefData();
const server = buildServer({
  config,
  log,
  mongo,
  store,
  lookup: refdata,
  extraStatus: () => ({ refdata: refdata.stats() }),
});

// Indexes first (they guarantee one bucket per scope per hour), then reference data.
void store
  .ensureIndexes()
  .then(() => log.info('metrics indexes ready'))
  .catch((err: unknown) => log.error({ err }, 'could not create metrics indexes'));
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
