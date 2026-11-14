import type { AddressInfo } from 'node:net';
import { createMemoryIncidentStore } from './db/incidents.ts';
import {
  checkSeq,
  EV,
  type FeedBatch,
  frameSchema,
  historyResponseSchema,
  LIMITS,
  NAMESPACES,
  type ClientToServerEvents,
  type Frame,
  type ResyncAck,
  type ServerToClientEvents,
  type SubAck,
} from '@ins/shared';
import { io as connect, type Socket } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import type { Mongo } from './db/client.ts';
import type { MetricsStore, MinuteRow } from './db/metrics.ts';
import { createMemoryAuthStore } from './auth/store.ts';
import { createMemoryRunsStore } from './scenarios/runs.ts';
import { createLogger } from './logger.ts';
import { buildServer, type RunningServer } from './server.ts';
import { signAccessToken } from './auth/tokens.ts';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

// A stand-in for MongoDB, so this test needs no database.
let mongoUp = true;
const mongo = {
  ping: async () => mongoUp,
  close: async () => {},
} as unknown as Mongo;

// A stand-in for the metrics store: one stored minute for India, an hour ago.
const HOUR_AGO = Date.now() - 3600_000;
const storedMinute: MinuteRow = {
  t: HOUR_AGO - (HOUR_AGO % 60_000),
  slot: { ann: 900, wd: 100, pfx: 40, p50: 41.5, p95: 120, pings: 50, lost: 1, up: 30, down: 0 },
};
const reads: unknown[][] = [];
const store: MetricsStore = {
  ensureIndexes: async () => {},
  writeMinute: async () => 0,
  readMinutes: async (...args) => {
    reads.push(args);
    return args[0] === 'country' && args[1] === 'IN' ? [storedMinute] : [];
  },
  stats: { windows: 0, docs: 0, errors: 0, lastWriteMs: null },
};

let server: RunningServer;
let jwtSecret = '';
// Sockets the test declares slow (a real socket cannot be made slow on demand).
const slowIds = new Set<string>();
let baseUrl: string;
const clients: Client[] = [];

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    MODE: 'replay',
    // This file opens many sockets and requests quickly; limits have their own tests.
    API_RATE_PER_MIN: '100000',
    SOCKET_CONNECTIONS_PER_MIN: '100000',
    SOCKET_MESSAGES_PER_SEC: '100000',
    REPLAY_FACEBOOK_FILE: '/nonexistent/replay.ndjson.gz',
  });
  jwtSecret = config.JWT_SECRET;
  server = buildServer({
    config,
    log: createLogger(config),
    mongo,
    store,
    authStore: createMemoryAuthStore(),
    runsStore: createMemoryRunsStore(),
    incidentStore: createMemoryIncidentStore(),
    verifyGoogle: null,
    heartbeatMs: 20,
    conflateMs: 20,
    ringSize: 5,
    slowCheckMs: 20,
    slowSummaryMs: 100,
    backlog: (socket) =>
      slowIds.has(socket.id) ? { packets: 1000, bytes: 0 } : { packets: 0, bytes: 0 },
  });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
});

afterAll(() => server.close());

function openClient(): Promise<Client> {
  const client: Client = connect(baseUrl + NAMESPACES.live, {
    // The server speaks MessagePack (SOCKET_PARSER default), so the client must too.
    parser: msgpackParser,
    transports: ['websocket'],
    forceNew: true,
  });
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

const sub = (client: Client, payload: unknown) =>
  new Promise<SubAck>((resolve) => client.emit(EV.sub, payload as never, resolve));

function collectFrames(client: Client, count: number): Promise<Frame[]> {
  return new Promise((resolve) => {
    const frames: Frame[] = [];
    client.on(EV.frame, (frame) => {
      frames.push(frame);
      if (frames.length === count) resolve(frames);
    });
  });
}

describe('REST', () => {
  it('reports liveness, readiness and status', async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(200);

    const status = (await (await fetch(`${baseUrl}/api/status`)).json()) as { mode: string };
    expect(status.mode).toBe('replay');
  });

  it('is not ready while MongoDB is unreachable', async () => {
    mongoUp = false;
    const ready = await fetch(`${baseUrl}/readyz`);
    mongoUp = true;
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ok: false, mongo: false });
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('/live namespace', () => {
  it('sends nothing before a client subscribes', async () => {
    const client = await openClient();
    let received = 0;
    client.on(EV.frame, () => (received += 1));
    await new Promise((resolve) => setTimeout(resolve, 100)); // five heartbeats
    expect(received).toBe(0);
  });

  it('delivers valid frames that continue exactly from the acknowledged sequence', async () => {
    const client = await openClient();
    const framesPromise = collectFrames(client, 4);

    const ack = await sub(client, { rooms: ['world'] });
    if (!ack.ok) throw new Error(ack.error.message);
    const start = ack.seqs.world!;

    const frames = await framesPromise;
    for (const frame of frames) expect(frameSchema.safeParse(frame).success).toBe(true);
    expect(frames.map((f) => f.r)).toEqual(['world', 'world', 'world', 'world']);
    expect(frames.map((f) => f.s)).toEqual([start + 1, start + 2, start + 3, start + 4]);
    expect(frames[0]!.d[0]![1]).toBe('tick');
  });

  it('tells a client that joins later the current viewer count', async () => {
    const first = await openClient();
    await sub(first, { rooms: ['world'] });
    await collectFrames(first, 3); // the count has been sent and has not changed since

    const late = await openClient();
    const framesPromise = collectFrames(late, 3);
    await sub(late, { rooms: ['world'] });
    const deltas = (await framesPromise).flatMap((frame) => frame.d);
    expect(deltas).toContainEqual(['sys', 'sockets', 2]);
  });

  it('gives a joiner the current values in its acknowledgement, and re-sends nothing to others', async () => {
    const first = await openClient();
    await sub(first, { rooms: ['country:KR'] });
    server.broadcaster.set('country:KR', 'now', 'health', 55);
    server.broadcaster.append('country:KR', 's:1', 'bgp', { ann: 1, wd: 0, pfx: 0 });
    server.broadcaster.flush();
    await new Promise((r) => setTimeout(r, 50));

    let firstGot = 0;
    first.on(EV.frame, (f) => f.r === 'country:KR' && (firstGot += 1));
    const late = await openClient();
    const ack = await sub(late, { rooms: ['country:KR'] });
    // Current values only: the record (a closed second) is history, not state.
    expect(ack).toMatchObject({ ok: true, state: { 'country:KR': [['now', 'health', 55]] } });
    await new Promise((r) => setTimeout(r, 80));
    expect(firstGot).toBe(0);
  });

  it('stops delivering after unsub', async () => {
    const client = await openClient();
    await sub(client, { rooms: ['world'] });
    await new Promise<void>((resolve) =>
      client.emit(EV.unsub, { rooms: ['world'] }, () => resolve()),
    );

    let received = 0;
    client.on(EV.frame, () => (received += 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toBe(0);
  });

  it('rejects malformed subscriptions', async () => {
    const client = await openClient();
    for (const bad of [null, 'world', {}, { rooms: [] }, { rooms: ['not-a-room'] }]) {
      const ack = await sub(client, bad);
      expect(ack).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    }
  });

  it('refuses rooms that belong to other namespaces', async () => {
    const client = await openClient();
    for (const room of ['ops', 'user:65a1b2c3d4e5f60718293a4b']) {
      const ack = await sub(client, { rooms: [room] });
      expect(ack).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
  });

  it('caps the number of rooms per socket', async () => {
    const client = await openClient();
    const first = Array.from({ length: LIMITS.maxRoomsPerSocket }, (_, i) => `asn:${i + 1}`);
    expect((await sub(client, { rooms: first })).ok).toBe(true);

    // Re-subscribing to rooms already joined is fine; one more new room is not.
    expect((await sub(client, { rooms: first.slice(0, 3) })).ok).toBe(true);
    const ack = await sub(client, { rooms: ['world'] });
    expect(ack).toMatchObject({ ok: false, error: { code: 'too_many_rooms' } });
  });
});

describe('GET /api/history', () => {
  const get = (query: string) => fetch(`${baseUrl}/api/history?${query}`);

  it('returns stored minutes with a health score, and the room snapshot sequence', async () => {
    const from = Date.now() - 2 * 3600_000;
    const res = await get(`scope=country&key=IN&from=${from}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = historyResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ scope: 'country', key: 'IN', room: 'country:IN', snapshotSeq: 0 });
    expect(body.minutes).toEqual([
      {
        t: storedMinute.t,
        ann: 900,
        wd: 100,
        pfx: 40,
        p50: 41.5,
        p95: 120,
        up: 30,
        down: 0,
        health: 100,
        late: 0,
      },
    ]);
    expect(body.seconds).toEqual([]);
  });

  it('reports the world room sequence, which advances with every live frame', async () => {
    // Frames (and sequence numbers) are only spent on rooms someone is in.
    const watcher = await openClient();
    await sub(watcher, { rooms: ['world'] });
    const first = historyResponseSchema.parse(
      await (await get(`scope=world&from=${Date.now() - 60_000}`)).json(),
    );
    await new Promise((r) => setTimeout(r, 60)); // a few 20 ms heartbeats
    const second = historyResponseSchema.parse(
      await (await get(`scope=world&from=${Date.now() - 60_000}`)).json(),
    );
    expect(first.room).toBe('world');
    expect(second.snapshotSeq).toBeGreaterThan(first.snapshotSeq);
  });

  it('never asks the database for more than it keeps', async () => {
    reads.length = 0;
    await get(`scope=asn&key=13335&from=${Date.now() - 30 * 86_400_000}`);
    const [, , from] = reads[0] as [string, string, number];
    expect(Date.now() - from).toBeLessThanOrEqual(2 * 86_400_000 + 1000);
  });

  it('rejects malformed queries', async () => {
    for (const query of [
      '',
      'scope=planet&from=1731480000000',
      'scope=country&key=india&from=1731480000000',
      'scope=asn&key=IN&from=1731480000000',
      'scope=world&from=yesterday',
      'scope=world&from=1731480000', // seconds instead of milliseconds
    ]) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
    }
  });
});

describe('rooms, conflation and resync', () => {
  const resync = (client: Client, payload: unknown) =>
    new Promise<ResyncAck>((resolve) => client.emit(EV.resync, payload as never, resolve));
  const nextFrame = (client: Client, room: string) =>
    new Promise<Frame>((resolve) => {
      const onFrame = (frame: Frame) => {
        if (frame.r !== room) return;
        client.off(EV.frame, onFrame);
        resolve(frame);
      };
      client.on(EV.frame, onFrame);
    });

  it('sends a country room only its own data, with sequence numbers from 1', async () => {
    const india = await openClient();
    const germany = await openClient();
    await sub(india, { rooms: ['country:IN'] });
    await sub(germany, { rooms: ['country:DE'] });

    let germanyGotIndia = false;
    germany.on(EV.frame, (f) => (germanyGotIndia ||= f.r === 'country:IN'));
    const frame = nextFrame(india, 'country:IN');
    server.broadcaster.append('country:IN', 's:1794565823000', 'bgp', { ann: 34, wd: 5, pfx: 2 });
    server.broadcaster.set('country:IN', 'now', 'health', 97);

    expect(await frame).toMatchObject({
      r: 'country:IN',
      s: 1,
      d: [
        ['s:1794565823000', 'bgp', { ann: 34, wd: 5, pfx: 2 }],
        ['now', 'health', 97],
      ],
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(germanyGotIndia).toBe(false);
  });

  it('conflates: within one interval only the last value of a key is sent', async () => {
    const client = await openClient();
    await sub(client, { rooms: ['country:FR'] });
    server.broadcaster.flush();
    const frame = nextFrame(client, 'country:FR');
    for (const health of [90, 80, 70])
      server.broadcaster.set('country:FR', 'now', 'health', health);
    server.broadcaster.append('country:FR', 's:1', 'bgp', { ann: 1, wd: 0, pfx: 0 });
    server.broadcaster.append('country:FR', 's:2', 'bgp', { ann: 2, wd: 0, pfx: 0 });
    server.broadcaster.flush();
    expect((await frame).d).toEqual([
      ['now', 'health', 70],
      ['s:1', 'bgp', { ann: 1, wd: 0, pfx: 0 }],
      ['s:2', 'bgp', { ann: 2, wd: 0, pfx: 0 }],
    ]);
  });

  it('does not resend an unchanged value, or one within epsilon', async () => {
    const client = await openClient();
    await sub(client, { rooms: ['country:ES'] });
    server.broadcaster.set('country:ES', 'now', 'health', 90);
    server.broadcaster.flush();
    const skippedBefore = server.broadcaster.stats.skippedUnchanged;
    server.broadcaster.set('country:ES', 'now', 'health', 90);
    server.broadcaster.set('country:ES', 'now', 'health', 90.5, 1);
    expect(server.broadcaster.stats.skippedUnchanged).toBe(skippedBefore + 2);
  });

  it('spends no sequence numbers on a room nobody is in', async () => {
    server.broadcaster.append('country:JP', 's:1', 'bgp', { ann: 1, wd: 0, pfx: 0 });
    server.broadcaster.flush();
    const client = await openClient();
    const ack = await sub(client, { rooms: ['country:JP'] });
    expect(ack).toMatchObject({ ok: true, seqs: { 'country:JP': 0 } });
  });

  it('replays missed frames on resync, and says when they are too old', async () => {
    const client = await openClient();
    await sub(client, { rooms: ['country:BR'] });
    for (let i = 1; i <= 3; i++) {
      server.broadcaster.append('country:BR', `s:${i}`, 'bgp', { ann: i, wd: 0, pfx: 0 });
      server.broadcaster.flush();
    }
    const replayed = await resync(client, { r: 'country:BR', after: 1 });
    expect(replayed.ok && replayed.frames.map((f) => f.s)).toEqual([2, 3]);
    expect(await resync(client, { r: 'country:BR', after: 3 })).toEqual({ ok: true, frames: [] });

    // The ring keeps 5 frames in this test; push it past that.
    for (let i = 4; i <= 9; i++) {
      server.broadcaster.append('country:BR', `s:${i}`, 'bgp', { ann: i, wd: 0, pfx: 0 });
      server.broadcaster.flush();
    }
    expect(await resync(client, { r: 'country:BR', after: 1 })).toMatchObject({
      ok: false,
      error: { code: 'gap_too_old' },
    });
    const recent = await resync(client, { r: 'country:BR', after: 5 });
    expect(recent.ok && recent.frames.map((f) => f.s)).toEqual([6, 7, 8, 9]);
  });

  it('refuses resync for a room the client is not in, and malformed requests', async () => {
    const client = await openClient();
    expect(await resync(client, { r: 'country:BR', after: 0 })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    for (const bad of [
      null,
      { r: 'country:BR' },
      { r: 'nowhere', after: 1 },
      { r: 'world', after: -1 },
    ]) {
      expect(await resync(client, bad)).toMatchObject({
        ok: false,
        error: { code: 'bad_request' },
      });
    }
  });
});

describe('slow clients', () => {
  const until = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  it('get one merged frame per interval instead of every frame, then return to normal', async () => {
    const client = await openClient();
    const ack = await sub(client, { rooms: ['country:JP'] });
    if (!ack.ok) throw new Error('sub failed');
    let last = ack.seqs['country:JP']!;
    const frames: Frame[] = [];
    client.on(EV.frame, (f) => {
      if (f.r !== 'country:JP') return;
      // Every frame must continue the stream with no gap.
      expect(checkSeq(last, f.s, f.f)).toBe('next');
      last = f.s;
      frames.push(f);
    });

    slowIds.add(client.id!);
    await until(() => server.slow.isSlow(client.id!));

    // Three normal frames' worth of changes (conflation is 20 ms in this test).
    const b = server.broadcaster;
    b.set('country:JP', 'now', 'health', 90);
    b.append('country:JP', 's:1', 'bgp', { ann: 1, wd: 0, pfx: 0 });
    b.flush();
    b.set('country:JP', 'now', 'health', 80);
    b.append('country:JP', 's:2', 'bgp', { ann: 2, wd: 0, pfx: 0 });
    b.flush();
    b.set('country:JP', 'now', 'health', 70);
    b.flush();
    expect(frames).toHaveLength(0); // normal frames skip a slow client

    await until(() => frames.length === 1, 1000);
    const summary = frames[0]!;
    expect(summary.f).toBe(summary.s - 2); // covers the three frames
    expect(summary.d).toEqual([
      ['s:1', 'bgp', { ann: 1, wd: 0, pfx: 0 }],
      ['s:2', 'bgp', { ann: 2, wd: 0, pfx: 0 }],
      ['now', 'health', 70], // only the latest value
    ]);

    slowIds.delete(client.id!);
    await until(() => !server.slow.isSlow(client.id!));
    b.set('country:JP', 'now', 'health', 60);
    b.flush();
    await until(() => frames.length === 2);
    expect(frames[1]).toMatchObject({ s: summary.s + 1, d: [['now', 'health', 60]] });
    expect(frames[1]!.f).toBeUndefined();
    expect(server.slow.stats).toMatchObject({ downgrades: 1, recoveries: 1 });
  });
});

describe('firehose', () => {
  it('sends a sample of raw events to a feed room, volatile, one feed per socket', async () => {
    const client = await openClient();
    expect((await sub(client, { rooms: ['feed:*:*'] })).ok).toBe(true);
    expect(await sub(client, { rooms: ['feed:bgp.withdraw:*'] })).toMatchObject({
      ok: false,
      error: { code: 'too_many_rooms' },
    });

    const batches: FeedBatch[] = [];
    client.on(EV.feed, (b) => batches.push(b));
    // Give the ingest thread a moment to hear that the room has a member.
    await new Promise((r) => setTimeout(r, 100));
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      server.ingest.ingest(
        'replay',
        [
          {
            v: 1,
            src: 'replay',
            eid: `replay:feed-${now}-${i}`,
            kind: 'bgp.withdraw',
            ts: now,
            its: now,
            entity: { prefix: `10.${i}.0.0/16`, collector: 'rrc00' },
            data: { peerAsn: 3356 },
          },
        ],
        now,
      );
    }
    const end = Date.now() + 2000;
    while (batches.reduce((n, b) => n + b.n, 0) < 30 && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    // Every matching event is counted, but at most 20 a second are sent (5 per quarter second).
    expect(batches.reduce((n, b) => n + b.n, 0)).toBe(30);
    for (const b of batches) {
      expect(b.r).toBe('feed:*:*');
      expect(b.e.length).toBe(Math.min(5, b.n));
    }
    expect(batches[0]!.e[0]).toMatchObject({
      k: 'bgp.withdraw',
      src: 'replay',
      col: 'rrc00',
      peer: 3356,
    });
  });
});

describe('metrics', () => {
  const token = (role: 'user' | 'admin') =>
    signAccessToken({ id: '65a1b2c3d4e5f60718293a4b', role, email: 'x@example.com' }, jwtSecret)
      .token;

  it('serves Prometheus metrics to admins only', async () => {
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
    const asUser = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${token('user')}` },
    });
    expect(asUser.status).toBe(403);

    const res = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${token('admin')}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await res.text();
    for (const name of [
      'ins_queue_depth',
      'ins_processing_delay_ms',
      'ins_event_loop_delay_ms',
      'ins_sockets{namespace="live"}',
      'ins_bytes_out_total',
      'ins_mongo_write_seconds_bucket',
      'ins_node_nodejs_heap_size_total_bytes',
    ]) {
      expect(text, name).toContain(name);
    }
  });

  it('gives anyone the per-minute ops history, and validates the query', async () => {
    expect((await fetch(`${baseUrl}/api/ops/history`)).status).toBe(400);
    const res = await fetch(`${baseUrl}/api/ops/history?from=${Date.now() - 3600_000}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: [] });
  });
});

describe('stats room', () => {
  it('sends the public pipeline and delivery numbers to whoever joins', async () => {
    const client = await openClient();
    const seen = new Map<string, Set<string>>();
    client.on(EV.frame, (f) => {
      if (f.r !== 'stats') return;
      for (const [key, field] of f.d) {
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)!.add(field);
      }
    });
    expect((await sub(client, { rooms: ['stats'] })).ok).toBe(true);
    const end = Date.now() + 2000;
    while (!(seen.get('out')?.has('bps') && seen.has('queue')) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect([...(seen.get('queue') ?? [])]).toEqual(
      expect.arrayContaining(['depth', 'fill', 'pressure', 'every', 'shed']),
    );
    expect([...(seen.get('delay') ?? [])]).toEqual(expect.arrayContaining(['p50', 'p95', 'p99']));
    expect([...(seen.get('loop') ?? [])]).toEqual(expect.arrayContaining(['main', 'ingest']));
    expect(seen.get('out')?.has('bps')).toBe(true); // a rate: needs two ticks
    expect(seen.get('sock')?.has('live')).toBe(true);
  });

  it('tells the time, for clock-offset estimates', async () => {
    const before = Date.now();
    const { t } = (await (await fetch(`${baseUrl}/api/time`)).json()) as { t: number };
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
