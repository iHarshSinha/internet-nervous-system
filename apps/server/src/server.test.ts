import type { AddressInfo } from 'node:net';
import {
  EV,
  frameSchema,
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
import { createLogger } from './logger.ts';
import { buildServer, type RunningServer } from './server.ts';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

// A stand-in for MongoDB, so this test needs no database.
let mongoUp = true;
const mongo = {
  ping: async () => mongoUp,
  close: async () => {},
} as unknown as Mongo;

let server: RunningServer;
let baseUrl: string;
const clients: Client[] = [];

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', MODE: 'replay' });
  server = buildServer({ config, log: createLogger(config), mongo, heartbeatMs: 20 });
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
