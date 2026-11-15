import { describe, expect, it } from 'vitest';
import {
  checkSeq,
  eventEnvelopeSchema,
  frameSchema,
  historyQuerySchema,
  kindAllowedFrom,
  LIMITS,
  makeEid,
  NAMESPACES,
  namespaceOf,
  parseRoom,
  resyncPayloadSchema,
  rooms,
  roomSchema,
  subPayloadSchema,
} from './index.ts';

// An example event in the envelope format (see docs/architecture.md).
const withdrawal = {
  v: 1,
  src: 'ris',
  eid: 'ris:21-80-249-208-189-11187052#0',
  kind: 'bgp.withdraw',
  ts: 1633362012345,
  its: 1633362012601,
  entity: { asn: 32934, prefix: '129.134.30.0/24', cc: 'US', collector: 'rrc10' },
  data: { peerAsn: 3356, pathLen: 4 },
};

describe('event envelope', () => {
  it('accepts the example event from the plan', () => {
    expect(eventEnvelopeSchema.parse(withdrawal)).toEqual(withdrawal);
  });

  it('strips fields it does not know', () => {
    const parsed = eventEnvelopeSchema.parse({ ...withdrawal, extra: 1 });
    expect(parsed).not.toHaveProperty('extra');
  });

  it('rejects a timestamp given in seconds instead of milliseconds', () => {
    const result = eventEnvelopeSchema.safeParse({ ...withdrawal, ts: 1633362012 });
    expect(result.success).toBe(false);
  });

  it('rejects an event ID that does not start with its source', () => {
    const result = eventEnvelopeSchema.safeParse({ ...withdrawal, eid: 'atlas:123' });
    expect(result.success).toBe(false);
  });

  it('rejects a kind that the source cannot produce', () => {
    const result = eventEnvelopeSchema.safeParse({ ...withdrawal, kind: 'atlas.ping' });
    expect(result.success).toBe(false);
  });

  it('lets replay carry any kind', () => {
    expect(kindAllowedFrom('bgp.withdraw', 'replay')).toBe(true);
    expect(kindAllowedFrom('atlas.ping', 'replay')).toBe(true);
    expect(kindAllowedFrom('bgp.withdraw', 'atlas')).toBe(false);
  });

  it('rejects an unknown source, a bad country code and a missing field', () => {
    expect(eventEnvelopeSchema.safeParse({ ...withdrawal, src: 'twitter' }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...withdrawal, entity: { cc: 'usa' } }).success).toBe(
      false,
    );
    const { ts: _ts, ...withoutTs } = withdrawal;
    expect(eventEnvelopeSchema.safeParse(withoutTs).success).toBe(false);
  });

  it('builds one event ID per item of an upstream message', () => {
    expect(makeEid('ris', 'abc')).toBe('ris:abc');
    expect(makeEid('ris', 'abc', 0)).toBe('ris:abc#0');
    expect(makeEid('ris', 'abc', 1)).toBe('ris:abc#1');
  });
});

describe('rooms', () => {
  it('builds and parses every kind of room', () => {
    expect(parseRoom(rooms.world)).toEqual({ type: 'world' });
    expect(parseRoom(rooms.incidents)).toEqual({ type: 'incidents' });
    expect(parseRoom(rooms.arcs)).toEqual({ type: 'arcs' });
    expect(parseRoom(rooms.ops)).toEqual({ type: 'ops' });
    expect(parseRoom(rooms.stats)).toEqual({ type: 'stats' });
    expect(namespaceOf({ type: 'stats' })).toBe(NAMESPACES.live);
    expect(parseRoom(rooms.country('IN'))).toEqual({ type: 'country', cc: 'IN' });
    expect(parseRoom(rooms.asn(13335))).toEqual({ type: 'asn', asn: 13335 });
    expect(parseRoom(rooms.feed('bgp.withdraw', 'US'))).toEqual({
      type: 'feed',
      kind: 'bgp.withdraw',
      cc: 'US',
    });
    expect(parseRoom(rooms.feed('*', '*'))).toEqual({ type: 'feed', kind: '*', cc: '*' });
    const id = '65a1b2c3d4e5f60718293a4b';
    expect(parseRoom(rooms.user(id))).toEqual({ type: 'user', id });
  });

  it.each([
    '',
    'World',
    'country',
    'country:in',
    'country:IND',
    'country:IN:extra',
    'asn:',
    'asn:-1',
    'asn:01',
    'asn:4294967296',
    'asn:1.5',
    'feed:bgp.withdraw',
    'feed:nope:US',
    'feed:bgp.withdraw:us',
    'user:not-an-object-id',
    'everything',
  ])('rejects %j', (name) => {
    expect(parseRoom(name)).toBeNull();
    expect(roomSchema.safeParse(name).success).toBe(false);
  });

  it('maps each room to the namespace that guards it', () => {
    expect(namespaceOf({ type: 'world' })).toBe(NAMESPACES.live);
    expect(namespaceOf({ type: 'country', cc: 'IN' })).toBe(NAMESPACES.live);
    expect(namespaceOf({ type: 'user', id: 'x' })).toBe(NAMESPACES.user);
    expect(namespaceOf({ type: 'ops' })).toBe(NAMESPACES.admin);
  });
});

describe('frames', () => {
  const frame = {
    r: 'country:IN',
    s: 1842,
    t: 1731480000000,
    d: [
      ['IN', 'health', 87],
      ['IN', 'p95', null],
      ['AS13335', 'wd', 12],
    ],
  };

  it('accepts a delta frame', () => {
    expect(frameSchema.parse(frame)).toEqual(frame);
  });

  it('accepts an object value, as incidents use', () => {
    const incident = { ...frame, r: 'incidents', d: [['inc1', 'open', { severity: 'critical' }]] };
    expect(frameSchema.safeParse(incident).success).toBe(true);
  });

  it('rejects an unknown room, a negative sequence and a malformed delta', () => {
    expect(frameSchema.safeParse({ ...frame, r: 'nowhere' }).success).toBe(false);
    expect(frameSchema.safeParse({ ...frame, s: -1 }).success).toBe(false);
    expect(frameSchema.safeParse({ ...frame, d: [['IN', 'health']] }).success).toBe(false);
  });

  it('classifies sequence numbers', () => {
    expect(checkSeq(10, 11)).toBe('next');
    expect(checkSeq(10, 10)).toBe('duplicate');
    expect(checkSeq(10, 4)).toBe('duplicate');
    expect(checkSeq(10, 13)).toBe('gap');
    expect(checkSeq(0, 1)).toBe('next');
  });

  it('accepts a slow-client summary that covers frames f..s as the next step', () => {
    expect(checkSeq(10, 14, 11)).toBe('next'); // covers 11..14 exactly
    expect(checkSeq(10, 14, 9)).toBe('next'); // overlaps what we have: harmless
    expect(checkSeq(10, 14, 12)).toBe('gap'); // 11 is missing
    expect(checkSeq(14, 14, 11)).toBe('duplicate');
  });
});

describe('socket payloads', () => {
  it('accepts a subscription with filters', () => {
    const payload = { rooms: ['world', 'country:IN'], filters: { minSeverity: 'warning' } };
    expect(subPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects no rooms, too many rooms and unknown rooms', () => {
    expect(subPayloadSchema.safeParse({ rooms: [] }).success).toBe(false);
    const tooMany = Array.from({ length: LIMITS.maxRoomsPerSocket + 1 }, (_, i) => `asn:${i}`);
    expect(subPayloadSchema.safeParse({ rooms: tooMany }).success).toBe(false);
    expect(subPayloadSchema.safeParse({ rooms: ['world', 'hack'] }).success).toBe(false);
    expect(subPayloadSchema.safeParse('world').success).toBe(false);
  });

  it('validates resync requests', () => {
    expect(resyncPayloadSchema.safeParse({ r: 'world', after: 41 }).success).toBe(true);
    expect(resyncPayloadSchema.safeParse({ r: 'world', after: -1 }).success).toBe(false);
  });
});

describe('history query', () => {
  const from = '1731480000000';

  it('coerces query-string numbers', () => {
    const q = historyQuerySchema.parse({ scope: 'country', key: 'IN', from });
    expect(q.from).toBe(1731480000000);
    expect(q.to).toBeUndefined();
  });

  it('checks that the key matches the scope', () => {
    expect(historyQuerySchema.safeParse({ scope: 'asn', key: '13335', from }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ scope: 'world', from }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ scope: 'asn', key: 'IN', from }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ scope: 'country', key: '13335', from }).success).toBe(
      false,
    );
  });

  it('rejects a range that ends before it starts', () => {
    const q = { scope: 'world', from, to: '1731470000000' };
    expect(historyQuerySchema.safeParse(q).success).toBe(false);
  });
});
