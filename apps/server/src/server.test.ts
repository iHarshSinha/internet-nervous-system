import type { AddressInfo } from 'node:net';
import {
  EV,
  frameSchema,
  historyResponseSchema,
  LIMITS,
  NAMESPACES,
  type ClientToServerEvents,
  type Frame,
  type ServerToClientEvents,
  type SubAck,
} from '@ins/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import type { Mongo } from './db/client.ts';
import type { MetricsStore, MinuteRow } from './db/metrics.ts';
import { createLogger } from './logger.ts';
import { buildServer, type RunningServer } from './server.ts';

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
let baseUrl: string;
const clients: Client[] = [];

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', MODE: 'replay' });
  server = buildServer({ config, log: createLogger(config), mongo, store, heartbeatMs: 20 });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
});

afterAll(() => server.close());

function openClient(): Promise<Client> {
  const client: Client = connect(baseUrl + NAMESPACES.live, {
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
