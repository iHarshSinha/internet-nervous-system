import { MongoClient, type Db } from 'mongodb';

export interface Mongo {
  db: Db;
  /** True if MongoDB answers a ping right now. Used by `/readyz`. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Create the MongoDB client. The driver connects lazily on the first command
 * and reconnects by itself, so the server can start even while the database
 * is still coming up; `/readyz` reports the truth in the meantime.
 */
export function createMongo(uri: string): Mongo {
  const client = new MongoClient(uri, {
    appName: 'internet-nervous-system',
    serverSelectionTimeoutMS: 2000,
  });
  const db = client.db(); // database name comes from the URI

  return {
    db,
    async ping() {
      try {
        await db.command({ ping: 1 });
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.close(),
  };
}
