import type { AddressInfo } from 'node:net';
import { eventEnvelopeSchema, type EventEnvelope } from '@ins/shared';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { IngestStats } from '../stats.ts';
import { createAtlasSource } from './atlas.ts';
import { normaliseAtlasPing, normaliseAtlasStatus, normaliseRis } from './normalise.ts';
import { createRisSource } from './ris.ts';
import { UpstreamSocket } from './upstream-socket.ts';

const log = pino({ level: 'silent' });
const NOW = 1794559323000;

// Real messages recorded on 13 Nov 2026, trimmed.
const risUpdate = {
  timestamp: 1794559322.51,
  peer: '2a00:1632::',
  peer_asn: '49544',
  id: '2a00:1632::-01a1d412298e0046',
  host: 'rrc25.ripe.net',
  type: 'UPDATE' as const,
  path: [49544, 6939, 61049, 207841, 44324, 219378],
  announcements: [
    { next_hop: '2a00:1632::', prefixes: ['2a0f:1cc5:450c::/47', '2a0f:1cc5:4600::/40'] },
  ],
  withdrawals: ['2602:f86f:5a::/48'],
};
const ping = {
  type: 'ping' as const,
  af: 4 as const,
  msm_id: 1008,
  prb_id: 1011787,
  timestamp: 1794559291,
  sent: 3,
  rcvd: 3,
  min: 101.72,
  avg: 101.85,
  max: 102.06,
};
const status = {
  timestamp: 1794559330,
  prb_id: 1015551,
  event: 'disconnect' as const,
  asn: null,
  prefix: null,
};

describe('normalising upstream messages', () => {
  it('turns a RIS update into one valid event per prefix, withdrawals first', () => {
    const events = normaliseRis(risUpdate, NOW);
    for (const event of events) expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);

    expect(events.map((e) => [e.eid, e.kind, e.entity.prefix])).toEqual([
      ['ris:2a00:1632::-01a1d412298e0046#0', 'bgp.withdraw', '2602:f86f:5a::/48'],
      ['ris:2a00:1632::-01a1d412298e0046#1', 'bgp.announce', '2a0f:1cc5:450c::/47'],
      ['ris:2a00:1632::-01a1d412298e0046#2', 'bgp.announce', '2a0f:1cc5:4600::/40'],
    ]);
    expect(events[1]).toMatchObject({
      src: 'ris',
      ts: 1794559322510, // seconds converted to milliseconds
      its: NOW,
      entity: { asn: 219378, collector: 'rrc25' },
      data: { peerAsn: 49544, pathLen: 6 },
    });
    // A withdrawal does not say which network owned the prefix.
    expect(events[0]!.entity.asn).toBeUndefined();
  });

  it('leaves the origin out when the path ends in an AS set', () => {
    const [event] = normaliseRis({ ...risUpdate, withdrawals: [], path: [1, [2, 3]] }, NOW);
    expect(event!.entity.asn).toBeUndefined();
  });

  it('produces nothing for messages that are not updates', () => {
    expect(normaliseRis({ ...risUpdate, type: 'KEEPALIVE' }, NOW)).toEqual([]);
  });

  it('turns an Atlas ping into a valid event keyed by measurement, probe and time', () => {
    const event = normaliseAtlasPing(ping, NOW);
    expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      eid: 'atlas:1008-1011787-1794559291',
      kind: 'atlas.ping',
      ts: 1794559291000,
      entity: { probeId: 1011787, msmId: 1008 },
      data: { rtt: 101.85, sent: 3, rcvd: 3 },
    });
  });

  it('reports a lost ping as rtt null', () => {
    const lost = normaliseAtlasPing({ ...ping, rcvd: 0, min: -1, avg: -1, max: -1 }, NOW);
    expect(lost.data.rtt).toBeNull();
  });

  it('turns a probe status change into a valid event', () => {
    const event = normaliseAtlasStatus(status, NOW);
    expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      eid: 'atlas:status-1015551-1794559330-disconnect',
      kind: 'atlas.probe_status',
      data: { event: 'disconnect' },
    });
  });
});

// ---- the connectors, against a local stand-in for the upstream feed

let server: WebSocketServer | null = null;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** Start a fake feed. `onClient` gets each connection and what it subscribed to. */
function fakeFeed(onClient: (ws: WebSocket, subscription: unknown, nth: number) => void): string {
  server = new WebSocketServer({ port: 0 });
  let connections = 0;
  server.on('connection', (ws) => {
    const nth = ++connections;
    ws.once('message', (raw) => onClient(ws, JSON.parse(raw.toString()), nth));
  });
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
};

describe('UpstreamSocket', () => {
  it('reconnects and subscribes again after the feed drops the connection', async () => {
    const subscriptions: unknown[] = [];
    const url = fakeFeed((ws, subscription, nth) => {
      subscriptions.push(subscription);
      ws.send(`hello ${nth}`);
      if (nth === 1) ws.terminate(); // the feed cuts us off, as RIS Live did in Phase 0
    });

    const received: string[] = [];
    const socket = new UpstreamSocket({
      name: 'test',
      url,
      log,
      baseDelayMs: 10,
      subscribe: (send) => send({ want: 'everything' }),
      onText: (text) => received.push(text),
    });
    cleanups.push(() => socket.stop());
    socket.start();

    await until(() => received.includes('hello 2'));
    expect(subscriptions).toEqual([{ want: 'everything' }, { want: 'everything' }]);
    expect(socket.stats).toMatchObject({ connected: true, reconnects: 1, messages: 2 });
  });

  it('keeps retrying while the feed is unreachable', async () => {
    const socket = new UpstreamSocket({
      name: 'test',
      url: 'ws://127.0.0.1:9', // nothing listens here
      log,
      baseDelayMs: 5,
      maxDelayMs: 10,
      subscribe: () => {},
      onText: () => {},
    });
    cleanups.push(() => socket.stop());
    socket.start();
    await until(() => socket.stats.reconnects >= 3);
    expect(socket.stats.connected).toBe(false);
  });
});

describe('RIS source', () => {
  it('opens one filtered connection per collector and emits valid events', async () => {
    const subscriptions: unknown[] = [];
    const url = fakeFeed((ws, subscription) => {
      subscriptions.push(subscription);
      ws.send(JSON.stringify({ type: 'ris_message', data: risUpdate }));
      ws.send(JSON.stringify({ type: 'ris_message', data: { ...risUpdate, id: undefined } }));
      ws.send('not json');
      ws.send(JSON.stringify({ type: 'ris_error', data: { message: 'slow down' } }));
    });

    const stats = new IngestStats();
    const events: EventEnvelope[] = [];
    const sockets = createRisSource({
      clientName: 'test',
      collectors: ['rrc00', 'rrc10'],
      stats,
      log,
      sink: (batch) => events.push(...batch),
      url,
    });
    cleanups.push(() => sockets.forEach((s) => s.stop()));
    sockets.forEach((s) => s.start());

    await until(() => stats.of('ris').warnings === 2);
    expect(subscriptions).toEqual(
      expect.arrayContaining([
        { type: 'ris_subscribe', data: { host: 'rrc00', type: 'UPDATE' } },
        { type: 'ris_subscribe', data: { host: 'rrc10', type: 'UPDATE' } },
      ]),
    );
    // Per connection: one good message (3 events), one failing the schema, one not JSON.
    expect(events).toHaveLength(6);
    for (const event of events) expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
    expect(stats.of('ris')).toMatchObject({ messages: 6, events: 6, rejected: 4, warnings: 2 });
  });
});

describe('Atlas source', () => {
  it('subscribes to each measurement and to probe status, and emits valid events', async () => {
    const stats = new IngestStats();
    const events: EventEnvelope[] = [];
    const received: unknown[] = [];

    const url = fakeFeed((ws, first) => {
      received.push(first);
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
      ws.send(JSON.stringify(['atlas_subscribed', { streamType: 'result', msm: 1001 }]));
      ws.send(JSON.stringify(['atlas_result', ping]));
      ws.send(JSON.stringify(['atlas_probestatus', status]));
      ws.send(JSON.stringify(['atlas_result', { ...ping, prb_id: 'x' }]));
      ws.send(JSON.stringify(['atlas_error', 'messages were dropped']));
    });

    const socket = createAtlasSource({
      measurements: [1001, 1008],
      stats,
      log,
      sink: (batch) => events.push(...batch),
      url,
    });
    cleanups.push(() => socket.stop());
    socket.start();

    await until(() => stats.of('atlas').warnings === 1 && received.length === 3);
    expect(received).toEqual([
      ['atlas_subscribe', { streamType: 'result', msm: 1001 }],
      ['atlas_subscribe', { streamType: 'result', msm: 1008 }],
      ['atlas_subscribe', { streamType: 'probestatus' }],
    ]);
    expect(events.map((e) => e.kind)).toEqual(['atlas.ping', 'atlas.probe_status']);
    expect(stats.of('atlas')).toMatchObject({ messages: 3, events: 2, rejected: 1, warnings: 1 });
  });
});
