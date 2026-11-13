import { loadConfig } from './config.ts';
import { createMongo } from './db/client.ts';
import { createLogger } from './logger.ts';

/*
 * One-shot job run by the `seed` service in Docker Compose (and by hand with
 * `node dist/seed.js`). It prepares the database and exits.
 *
 * Phase 0 only records that the database has been initialised. Later phases
 * add index creation and loading of the recorded history and replay files.
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
  log.info({ firstRun: result.upsertedCount === 1 }, 'seed complete');
} catch (err) {
  log.error({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await mongo.close();
}
