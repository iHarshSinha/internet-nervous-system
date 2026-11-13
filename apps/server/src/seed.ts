import { loadConfig } from './config.ts';
import { createMongo } from './db/client.ts';
import { createMetricsStore } from './db/metrics.ts';
import { createMongoAuthStore } from './auth/store.ts';
import { createLogger } from './logger.ts';

/*
 * One-shot job run by the `seed` service in Docker Compose (and by hand with
 * `node dist/seed.js`). It prepares the database and exits.
 *
 * It records that the database has been initialised and creates indexes.
 * Phase 2 adds loading of the recorded history and replay files.
 * Every step must stay idempotent: running the job twice changes nothing.
 */

const config = loadConfig();
const log = createLogger(config);
const mongo = createMongo(config.MONGODB_URI);

try {
  const result = await mongo.db
    .collection<{ _id: string; schema: number; createdAt: Date }>('meta')
    // $setOnInsert writes only when the document does not exist yet.
    .updateOne(
      { _id: 'seed' },
      { $setOnInsert: { schema: 1, createdAt: new Date() } },
      { upsert: true },
    );
  await createMetricsStore(mongo.db, config.METRICS_ASN_LIMIT).ensureIndexes();
  await createMongoAuthStore(mongo.db).ensureIndexes();
  log.info({ firstRun: result.upsertedCount === 1 }, 'seed complete');
} catch (err) {
  log.error({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await mongo.close();
}
