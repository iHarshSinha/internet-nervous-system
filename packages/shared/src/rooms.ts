import { z } from 'zod';
import { EVENT_KINDS, NAMESPACES, type EventKind, type Namespace } from './constants.ts';

/** Matches every kind or every country in a `feed` room. */
export const WILDCARD = '*';

/**
 * Room names. Always build names with these helpers so the server and the
 * client can never disagree on spelling.
 */
export const rooms = {
  /** Global counters and per-country health changes. */
  world: 'world',
  /** Incident open, update and resolve. */
  incidents: 'incidents',
  /** Cloudflare attack pairs. */
  arcs: 'arcs',
  /** Pipeline metrics (in `/admin`). */
  ops: 'ops',
  /** Public, once a second: ingest, queue, delay and delivery numbers for the /ops page and HUD. */
  stats: 'stats',
  /** Metrics for one country. */
  country: (cc: string) => `country:${cc}`,
  /** Metrics for one network. */
  asn: (asn: number) => `asn:${asn}`,
  /** Sampled raw events of one kind for one country; `*` means all. */
  feed: (kind: EventKind | typeof WILDCARD, cc: string) => `feed:${kind}:${cc}`,
  /** Personal alerts for one user (in `/user`). */
  user: (id: string) => `user:${id}`,
} as const;

export type ParsedRoom =
  | { type: 'world' }
  | { type: 'incidents' }
  | { type: 'arcs' }
  | { type: 'ops' }
  | { type: 'stats' }
  | { type: 'country'; cc: string }
  | { type: 'asn'; asn: number }
  | { type: 'feed'; kind: EventKind | typeof WILDCARD; cc: string }
  | { type: 'user'; id: string };

const CC = /^[A-Z]{2}$/;
const ASN = /^(0|[1-9]\d{0,9})$/;
const USER_ID = /^[a-f0-9]{24}$/; // MongoDB ObjectId in hex

/** Parse a room name. Returns null if it is not a room we know. */
export function parseRoom(name: string): ParsedRoom | null {
  if (
    name === 'world' ||
    name === 'incidents' ||
    name === 'arcs' ||
    name === 'ops' ||
    name === 'stats'
  ) {
    return { type: name };
  }
  const [type, a, b, ...rest] = name.split(':');
  if (rest.length > 0) return null;

  switch (type) {
    case 'country':
      return a !== undefined && b === undefined && CC.test(a) ? { type, cc: a } : null;
    case 'asn': {
      if (a === undefined || b !== undefined || !ASN.test(a)) return null;
      const asn = Number(a);
      return asn <= 4_294_967_295 ? { type, asn } : null;
    }
    case 'feed': {
      if (a === undefined || b === undefined) return null;
      const kindOk = a === WILDCARD || (EVENT_KINDS as readonly string[]).includes(a);
      const ccOk = b === WILDCARD || CC.test(b);
      return kindOk && ccOk ? { type, kind: a as EventKind | typeof WILDCARD, cc: b } : null;
    }
    case 'user':
      return a !== undefined && b === undefined && USER_ID.test(a) ? { type, id: a } : null;
    default:
      return null;
  }
}

/** Which namespace a room lives in. Access control is enforced per namespace. */
export function namespaceOf(room: ParsedRoom): Namespace {
  if (room.type === 'user') return NAMESPACES.user;
  if (room.type === 'ops') return NAMESPACES.admin;
  return NAMESPACES.live;
}

/** A string that is a valid room name. */
export const roomSchema = z
  .string()
  .max(64)
  .refine((name) => parseRoom(name) !== null, 'unknown room');
