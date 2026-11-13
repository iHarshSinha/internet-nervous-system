import type { RadarEvent } from '@ins/shared';
import type { Db } from 'mongodb';

/**
 * Cloudflare Radar events, one document per event (`_id` = our event ID, so
 * polling the same event again only updates it). Kept 30 days.
 */
export interface RadarStore {
  ensureIndexes(): Promise<void>;
  /** Upsert; returns the events that were not stored before. */
  save(events: RadarEvent[]): Promise<RadarEvent[]>;
  recent(since: number, limit: number): Promise<RadarEvent[]>;
}

type Doc = Omit<RadarEvent, 'id'> & { _id: string; expireAt: Date };
const TTL_MS = 30 * 24 * 3600_000;

export function createMongoRadarStore(db: Db): RadarStore {
  const coll = db.collection<Doc>('radar_events');
  return {
    async ensureIndexes() {
      await coll.createIndex({ start: -1 });
      await coll.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    },
    async save(events) {
      if (events.length === 0) return [];
      const result = await coll.bulkWrite(
        events.map(({ id, ...rest }) => ({
          updateOne: {
            filter: { _id: id },
            update: { $set: { ...rest, expireAt: new Date(rest.start + TTL_MS) } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      const fresh = new Set(Object.values(result.upsertedIds).map(String));
      return events.filter((e) => fresh.has(e.id));
    },
    async recent(since, limit) {
      const docs = await coll
        .find({ $or: [{ start: { $gte: since } }, { end: null }] })
        .sort({ start: -1 })
        .limit(limit)
        .toArray();
      return docs.map(({ _id, expireAt: _e, ...rest }) => ({ id: _id, ...rest }));
    },
  };
}

export function createMemoryRadarStore(): RadarStore {
  const all = new Map<string, RadarEvent>();
  return {
    ensureIndexes: async () => {},
    async save(events) {
      const fresh = events.filter((e) => !all.has(e.id));
      for (const e of events) all.set(e.id, e);
      return fresh;
    },
    recent: async (since, limit) =>
      [...all.values()]
        .filter((e) => e.start >= since || e.end === null)
        .sort((a, b) => b.start - a.start)
        .slice(0, limit),
  };
}
