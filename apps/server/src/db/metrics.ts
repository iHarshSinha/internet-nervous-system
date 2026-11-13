import type { Db } from 'mongodb';
import type { Totals } from '../ingest/pipeline/aggregate.ts';
import type { WindowResult } from '../ingest/pipeline/pipeline.ts';

/*
 * metrics_hourly: the history behind every chart.
 *
 * One document per scope per hour (the "bucket pattern"), with a slot per
 * minute:
 *
 *   { scope: "country", key: "IN", hour: 2026-11-13T09:00Z,
 *     m: { "07": { ann: 812, wd: 40, pfx: 31, p50: 41.2, ... }, "08": {...} },
 *     expireAt: ... }
 *
 * Every write is `$set` on individual fields of one minute slot, never `$inc`.
 * Writing the same minute again (a restart, a replay) therefore leaves the
 * document exactly as it was: no double counting. Routing and latency windows
 * close at different times (latency waits about 4 minutes for stragglers), and
 * because each writes only its own fields, neither overwrites the other.
 *
 * This is a regular collection, not a time-series one, because time-series
 * collections cannot have the unique index that guarantees one bucket per hour.
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export type ScopeType = 'world' | 'country' | 'asn';

/** How long history is kept, sized for MongoDB Atlas M0's 512 MB limit. */
export const RETENTION_MS: Record<ScopeType, number> = {
  world: 7 * DAY,
  country: 3 * DAY,
  asn: 2 * DAY,
};

/** One minute's stored values. Each family fills in its own fields. */
export interface MinuteSlot {
  ann?: number;
  wd?: number;
  pfx?: number;
  p50?: number | null;
  p95?: number | null;
  pings?: number;
  lost?: number;
  up?: number;
  down?: number;
}

interface HourDoc {
  scope: ScopeType;
  key: string;
  hour: Date;
  m: Record<string, MinuteSlot>;
  expireAt: Date;
}

export interface MinuteRow {
  /** Start of the minute, in ms. */
  t: number;
  slot: MinuteSlot;
}

/** "world" -> world/"", "country:IN" -> country/IN, "asn:13335" -> asn/13335. */
export function splitScope(scope: string): { scope: ScopeType; key: string } | null {
  if (scope === 'world') return { scope: 'world', key: '' };
  const [type, key] = scope.split(':');
  if ((type === 'country' || type === 'asn') && key) return { scope: type, key };
  return null;
}

/** The fields a window of this family owns. */
function fieldsOf(family: WindowResult['family'], t: Totals): MinuteSlot {
  return family === 'bgp'
    ? { ann: t.ann, wd: t.wd, pfx: t.pfx }
    : { p50: t.p50, p95: t.p95, pings: t.pings, lost: t.lost, up: t.up, down: t.left };
}

/**
 * Which scopes of a window to store: the world, every country, and only the
 * busiest networks. A minute can touch 800+ networks; storing them all would
 * not fit the free database tier.
 */
export function selectScopes(window: WindowResult, asnLimit: number): [string, Totals][] {
  const keep: [string, Totals][] = [];
  const asns: [string, Totals][] = [];
  for (const entry of window.scopes) {
    if (entry[0].startsWith('asn:')) asns.push(entry);
    else keep.push(entry);
  }
  const activity = (t: Totals) => (window.family === 'bgp' ? t.ann + t.wd : t.pings);
  asns.sort((a, b) => activity(b[1]) - activity(a[1]));
  return keep.concat(asns.slice(0, asnLimit));
}

export interface MetricsStore {
  ensureIndexes(): Promise<void>;
  /** Store one closed 1-minute window. Returns the number of documents touched. */
  writeMinute(window: WindowResult): Promise<number>;
  /** Minutes in [from, to), oldest first. */
  readMinutes(scope: ScopeType, key: string, from: number, to: number): Promise<MinuteRow[]>;
  readonly stats: { windows: number; docs: number; errors: number; lastWriteMs: number | null };
}

export function createMetricsStore(db: Db, asnLimit: number): MetricsStore {
  const coll = db.collection<HourDoc>('metrics_hourly');
  const stats = { windows: 0, docs: 0, errors: 0, lastWriteMs: null as number | null };

  return {
    stats,

    async ensureIndexes() {
      await coll.createIndex({ scope: 1, key: 1, hour: 1 }, { unique: true });
      // MongoDB deletes a document once its expireAt has passed.
      await coll.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    },

    async writeMinute(window) {
      const hourMs = window.start - (window.start % HOUR);
      const hour = new Date(hourMs);
      const minute = String(new Date(window.start).getUTCMinutes()).padStart(2, '0');

      const ops = [];
      for (const [name, totals] of selectScopes(window, asnLimit)) {
        const split = splitScope(name);
        if (!split) continue;
        const set: Record<string, unknown> = {
          expireAt: new Date(hourMs + HOUR + RETENTION_MS[split.scope]),
        };
        for (const [field, value] of Object.entries(fieldsOf(window.family, totals))) {
          set[`m.${minute}.${field}`] = value;
        }
        ops.push({
          updateOne: {
            filter: { scope: split.scope, key: split.key, hour },
            update: { $set: set },
            upsert: true,
          },
        });
      }
      if (ops.length === 0) return 0;

      const started = performance.now();
      try {
        await coll.bulkWrite(ops, { ordered: false });
      } catch (err) {
        stats.errors += 1;
        throw err;
      }
      stats.lastWriteMs = Math.round(performance.now() - started);
      stats.windows += 1;
      stats.docs += ops.length;
      return ops.length;
    },

    async readMinutes(scope, key, from, to) {
      const docs = await coll
        .find(
          { scope, key, hour: { $gte: new Date(from - (from % HOUR)), $lt: new Date(to) } },
          { projection: { hour: 1, m: 1 } },
        )
        .sort({ hour: 1 })
        .toArray();

      const rows: MinuteRow[] = [];
      for (const doc of docs) {
        const base = doc.hour.getTime();
        for (const [mm, slot] of Object.entries(doc.m ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const t = base + Number(mm) * 60_000;
          if (t >= from && t < to) rows.push({ t, slot });
        }
      }
      return rows;
    },
  };
}
