import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Totals } from '../ingest/pipeline/aggregate.ts';
import type { WindowResult } from '../ingest/pipeline/pipeline.ts';
import { createMetricsStore, selectScopes, splitScope, type MetricsStore } from './metrics.ts';

const totals = (over: Partial<Totals> = {}): Totals => ({
  ann: 0,
  wd: 0,
  pfx: 0,
  p50: null,
  p95: null,
  pings: 0,
  lost: 0,
  up: 0,
  joined: 0,
  left: 0,
  ...over,
});

describe('splitScope and selectScopes', () => {
  it('splits scope names', () => {
    expect(splitScope('world')).toEqual({ scope: 'world', key: '' });
    expect(splitScope('country:IN')).toEqual({ scope: 'country', key: 'IN' });
    expect(splitScope('asn:13335')).toEqual({ scope: 'asn', key: '13335' });
    expect(splitScope('nope:1')).toBeNull();
  });

  it('keeps the world, every country and only the busiest networks', () => {
    const window: WindowResult = {
      family: 'bgp',
      start: 0,
      sizeMs: 60_000,
      scopes: new Map([
        ['world', totals({ ann: 100 })],
        ['country:IN', totals({ ann: 1 })],
        ['asn:1', totals({ ann: 5 })],
        ['asn:2', totals({ ann: 50 })],
        ['asn:3', totals({ wd: 20 })],
      ]),
    };
    expect(selectScopes(window, 2).map(([k]) => k)).toEqual([
      'world',
      'country:IN',
      'asn:2',
      'asn:3',
    ]);
  });
});

// ---- against a real MongoDB. Skipped (and reported as skipped) when none is running.

const URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const client = new MongoClient(URI, { serverSelectionTimeoutMS: 1000 });
const mongoUp = await client
  .connect()
  .then(() => true)
  .catch(() => false);

describe.skipIf(!mongoUp)('metrics store on MongoDB', () => {
  const db = client.db(`ins_test_${process.pid}`);
  let store: MetricsStore;
  const HOUR = Date.UTC(2026, 10, 13, 9); // 09:00 UTC
  const coll = () => db.collection('metrics_hourly');

  const bgp = (minute: number, ann: number): WindowResult => ({
    family: 'bgp',
    start: HOUR + minute * 60_000,
    sizeMs: 60_000,
    scopes: new Map([
      ['world', totals({ ann, wd: 3, pfx: 2 })],
      ['country:IN', totals({ ann: 7 })],
    ]),
  });
  const atlas = (minute: number): WindowResult => ({
    family: 'atlas',
    start: HOUR + minute * 60_000,
    sizeMs: 60_000,
    scopes: new Map([
      ['world', totals({ p50: 40.5, p95: 90, pings: 12, lost: 1, up: 9, left: 2 })],
    ]),
  });

  beforeAll(async () => {
    store = createMetricsStore(db, 300);
    await store.ensureIndexes();
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('writes one document per scope per hour, with a slot per minute', async () => {
    expect(await store.writeMinute(bgp(7, 100))).toBe(2);
    await store.writeMinute(bgp(8, 120));
    expect(await coll().countDocuments()).toBe(2);
    const world = await coll().findOne({ scope: 'world', key: '' });
    expect(world?.m).toEqual({
      '07': { ann: 100, wd: 3, pfx: 2 },
      '08': { ann: 120, wd: 3, pfx: 2 },
    });
    expect(world?.expireAt.getTime()).toBe(HOUR + 3600_000 + 7 * 86_400_000);
  });

  it('never double-counts: writing the same minute again changes nothing', async () => {
    const before = await coll().findOne({ scope: 'world', key: '' });
    await store.writeMinute(bgp(7, 100));
    await store.writeMinute(bgp(7, 100));
    expect(await coll().findOne({ scope: 'world', key: '' })).toEqual(before);
  });

  it('lets latency and routing fill the same minute without overwriting each other', async () => {
    await store.writeMinute(atlas(7));
    const world = await coll().findOne({ scope: 'world', key: '' });
    expect(world?.m['07']).toEqual({
      ann: 100,
      wd: 3,
      pfx: 2,
      p50: 40.5,
      p95: 90,
      pings: 12,
      lost: 1,
      up: 9,
      down: 2,
    });
  });

  it('refuses a second bucket for the same scope and hour', async () => {
    const doc = { scope: 'world', key: '', hour: new Date(HOUR), m: {}, expireAt: new Date() };
    await expect(coll().insertOne(doc)).rejects.toThrow(/duplicate key/);
  });

  it('reads minutes back in order, limited to the requested range', async () => {
    const rows = await store.readMinutes('world', '', HOUR, HOUR + 8 * 60_000);
    expect(rows.map((r) => r.t)).toEqual([HOUR + 7 * 60_000]);
    const all = await store.readMinutes('world', '', HOUR - 3600_000, HOUR + 3600_000);
    expect(all.map((r) => (r.t - HOUR) / 60_000)).toEqual([7, 8]);
    expect(await store.readMinutes('country', 'US', HOUR, HOUR + 3600_000)).toEqual([]);
  });
});

if (!mongoUp) await client.close().catch(() => {});
