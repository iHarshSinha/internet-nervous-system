import type { ScenarioId, ScenarioRun } from '@ins/shared';
import { ObjectId, type Db } from 'mongodb';

/**
 * A record of every scenario run: what, when, on which network and country.
 * Charts use it to mark simulated stretches, so injected data is never
 * mistaken for what really happened at that time.
 */
export interface RunsStore {
  started(
    scenario: ScenarioId,
    startedAt: number,
    asn: number | null,
    cc: string | null,
  ): Promise<string>;
  ended(id: string, endedAt: number): Promise<void>;
  /** Runs that overlap [from, to). */
  between(from: number, to: number): Promise<ScenarioRun[]>;
}

interface RunDoc {
  _id: ObjectId;
  scenario: ScenarioId;
  startedAt: Date;
  endedAt: Date | null;
  asn: number | null;
  cc: string | null;
}

export function createMongoRunsStore(db: Db): RunsStore {
  const runs = db.collection<RunDoc>('scenario_runs');
  return {
    async started(scenario, startedAt, asn, cc) {
      const _id = new ObjectId();
      await runs.insertOne({
        _id,
        scenario,
        startedAt: new Date(startedAt),
        endedAt: null,
        asn,
        cc,
      });
      return _id.toHexString();
    },
    async ended(id, endedAt) {
      await runs.updateOne({ _id: new ObjectId(id) }, { $set: { endedAt: new Date(endedAt) } });
    },
    async between(from, to) {
      const docs = await runs
        .find({
          startedAt: { $lt: new Date(to) },
          $or: [{ endedAt: null }, { endedAt: { $gte: new Date(from) } }],
        })
        .sort({ startedAt: 1 })
        .limit(200)
        .toArray();
      return docs.map((d) => ({
        id: d._id.toHexString(),
        scenario: d.scenario,
        startedAt: d.startedAt.getTime(),
        endedAt: d.endedAt?.getTime() ?? null,
        asn: d.asn,
        cc: d.cc,
      }));
    },
  };
}

export function createMemoryRunsStore(): RunsStore {
  const runs = new Map<string, ScenarioRun>();
  return {
    async started(scenario, startedAt, asn, cc) {
      const id = new ObjectId().toHexString();
      runs.set(id, { id, scenario, startedAt, endedAt: null, asn, cc });
      return id;
    },
    async ended(id, endedAt) {
      const run = runs.get(id);
      if (run) run.endedAt = endedAt;
    },
    async between(from, to) {
      return [...runs.values()].filter(
        (r) => r.startedAt < to && (r.endedAt === null || r.endedAt >= from),
      );
    },
  };
}
