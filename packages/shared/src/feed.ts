import { z } from 'zod';
import { EVENT_KINDS, SOURCES, type EventKind } from './constants.ts';
import { roomSchema } from './rooms.ts';

/*
 * The firehose: raw events, as they arrive, for the `feed:<kind>:<cc>` rooms.
 *
 * Unlike frames it is NOT a numbered, complete stream. It is a sample: at
 * most LIMITS.feedEventsPerSecond events per room, chosen at random from all
 * the room's events (and thinned further while the ingest queue is under
 * pressure). It is sent "volatile": a client that cannot keep up misses
 * batches rather than building a backlog. The counts and charts never come
 * from here; they come from frames, which are complete.
 */

/** One raw event, flattened to the fields a list row needs. */
export const feedEventSchema = z.object({
  /** Event ID (unique; the list's key). */
  id: z.string().max(200),
  /** Event time, ms. */
  t: z.number(),
  k: z.enum(EVENT_KINDS),
  src: z.enum(SOURCES),
  /** Country (network registration for routing, probe location for Atlas). */
  cc: z.string().length(2).nullable(),
  /** Origin network (routing) or the probe's network (Atlas). */
  asn: z.number().int().nullable(),
  /** Address block, for routing events. */
  p: z.string().max(64).optional(),
  /** Route collector and the AS of the router that told it. */
  col: z.string().max(16).optional(),
  peer: z.number().int().optional(),
  /** AS path of an announcement, first hop first. */
  path: z.array(z.number().int()).max(64).optional(),
  /** Atlas probe, and the round trip in ms (null: no reply). */
  prb: z.number().int().optional(),
  rtt: z.number().nullable().optional(),
  /** Probe connected or disconnected. */
  ev: z.string().max(32).optional(),
  /** Part of an admin-triggered simulation. */
  sim: z.boolean().optional(),
});
export type FeedEvent = z.infer<typeof feedEventSchema>;

/** One volatile message to a feed room: a sample of its events from the last quarter second. */
export const feedBatchSchema = z.object({
  r: roomSchema,
  /** How many events matched the room in that interval (before sampling). */
  n: z.number().int().nonnegative(),
  e: z.array(feedEventSchema).max(64),
});
export type FeedBatch = z.infer<typeof feedBatchSchema>;

/** Does an event of this kind and country belong in this feed room? */
export function feedRoomsFor(kind: EventKind, cc: string | null): string[] {
  const out = [`feed:${kind}:*`, 'feed:*:*'];
  if (cc) out.push(`feed:${kind}:${cc}`, `feed:*:${cc}`);
  return out;
}

/** Which wire format Socket.IO uses on this server (GET /api/realtime). */
export const SOCKET_PARSERS = ['msgpack', 'json'] as const;
export type SocketParser = (typeof SOCKET_PARSERS)[number];

export interface RealtimeConfig {
  parser: SocketParser;
  /** How often frames are sent to a normal client, and to a slow one. */
  conflateMs: number;
  slowSummaryMs: number;
  feedEventsPerSecond: number;
}
