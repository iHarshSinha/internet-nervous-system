import type { Db } from 'mongodb';

/**
 * ingest_stats: one document per minute per row, the history behind the
 * /ops charts. Rows are a live source ("ris", "atlas", "replay"), "pipeline"
 * (dedupe, lateness, queue, shedding, processing delay) and "delivery"
 * (sockets, frames, bytes, event-loop delay, MongoDB write time).
 *
 * `_id` is `<src>:<minute>`, so it is unique for free, and a write is `$set`
 * of that minute's values: writing the same minute twice changes nothing.
 * Kept 7 days.
 */
export type StatsRow = { src: string; t: number } & Record<string, number | string>;

export interface IngestStatsStore {
  ensureIndexes(): Promise<void>;
  write(rows: StatsRow[]): Promise<void>;
  /** Rows with `from <= t < to`, oldest first. */
  between(from: number, to: number): Promise<StatsRow[]>;
}

const TTL_MS = 7 * 24 * 3600_000;

export function createMongoIngestStatsStore(db: Db): IngestStatsStore {
  // Rows are open-ended records of numbers, so the collection is left untyped.
  const coll = db.collection<{ _id: string }>('ingest_stats');
  return {
    async ensureIndexes() {
      await coll.createIndex({ t: 1 });
      await coll.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    },
    async write(rows) {
      if (rows.length === 0) return;
      await coll.bulkWrite(
        rows.map((row) => ({
          updateOne: {
            filter: { _id: `${row.src}:${row.t}` },
            update: { $set: { ...row, expireAt: new Date(row.t + TTL_MS) } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    },
    async between(from, to) {
      const docs = await coll
        .find({ t: { $gte: from, $lt: to } }, { projection: { _id: 0, expireAt: 0 } })
        .sort({ t: 1 })
        .toArray();
      return docs as unknown as StatsRow[];
    },
  };
}

export function createMemoryIngestStatsStore(): IngestStatsStore {
  const all = new Map<string, StatsRow>();
  return {
    ensureIndexes: async () => {},
    async write(rows) {
      for (const row of rows) all.set(`${row.src}:${row.t}`, { ...row });
    },
    between: async (from, to) =>
      [...all.values()].filter((r) => r.t >= from && r.t < to).sort((a, b) => a.t - b.t),
  };
}
