import type { Incident } from '@ins/shared';
import type { Db } from 'mongodb';

/** Incidents are kept (no TTL): they are the record of what the system noticed. */
export interface IncidentStore {
  ensureIndexes(): Promise<void>;
  save(incident: Incident): Promise<void>;
  recent(limit: number, since: number): Promise<Incident[]>;
  /** Incidents changed since `since` (however long ago they opened), for restoring after a restart. */
  updatedSince(since: number, limit: number): Promise<Incident[]>;
  get(id: string): Promise<Incident | null>;
  /** After a restart nothing is watching old open incidents any more: close them honestly. */
  closeOrphans(now: number): Promise<number>;
}

type Doc = Omit<Incident, 'id'> & { _id: string };

const toIncident = ({ _id, ...rest }: Doc): Incident => ({ id: _id, ...rest });

export function createMongoIncidentStore(db: Db): IncidentStore {
  const coll = db.collection<Doc>('incidents');
  return {
    async ensureIndexes() {
      await coll.createIndex({ state: 1, updatedAt: -1 });
      await coll.createIndex({ scope: 1, openedAt: -1 });
      await coll.createIndex({ openedAt: -1 });
      await coll.createIndex({ updatedAt: -1 }); // restoring after a restart
    },
    async save({ id, ...rest }) {
      await coll.replaceOne({ _id: id }, rest, { upsert: true });
    },
    async recent(limit, since) {
      const docs = await coll
        .find({ openedAt: { $gte: since } })
        .sort({ openedAt: -1 })
        .limit(limit)
        .toArray();
      return docs.map(toIncident);
    },
    async updatedSince(since, limit) {
      const docs = await coll
        .find({ updatedAt: { $gte: since } })
        .limit(limit)
        .toArray();
      return docs.map(toIncident);
    },
    async get(id) {
      const doc = await coll.findOne({ _id: id });
      return doc ? toIncident(doc) : null;
    },
    async closeOrphans(now) {
      const result = await coll.updateMany(
        { state: { $ne: 'resolved' } },
        {
          $set: { state: 'resolved', resolvedAt: now, updatedAt: now },
          $push: { timeline: { at: now, text: 'Closed: the server restarted while it was open' } },
        },
      );
      return result.modifiedCount;
    },
  };
}

export function createMemoryIncidentStore(): IncidentStore {
  const all = new Map<string, Incident>();
  return {
    ensureIndexes: async () => {},
    save: async (i) => void all.set(i.id, structuredClone(i)),
    recent: async (limit, since) =>
      [...all.values()]
        .filter((i) => i.openedAt >= since)
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, limit),
    updatedSince: async (since, limit) =>
      [...all.values()].filter((i) => i.updatedAt >= since).slice(0, limit),
    get: async (id) => all.get(id) ?? null,
    closeOrphans: async () => 0,
  };
}
