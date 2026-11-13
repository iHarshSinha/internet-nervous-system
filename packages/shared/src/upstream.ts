import { z } from 'zod';

/*
 * Shapes of the messages the upstream feeds send us, written from real
 * messages recorded on 13 Nov 2026 (see docs/benchmarks.md). They check the
 * fields we rely on and let unknown extra fields through untouched, so a feed
 * adding a field never breaks ingestion.
 *
 * Both feeds give timestamps in SECONDS; connectors convert to milliseconds.
 */

// ---------------------------------------------------------------- RIS Live

export const RIS_MESSAGE_TYPES = [
  'UPDATE',
  'KEEPALIVE',
  'OPEN',
  'NOTIFICATION',
  'RIS_PEER_STATE',
  'STATE',
] as const;

export const risDataSchema = z.looseObject({
  /** Seconds since the epoch, with a fraction. */
  timestamp: z.number().positive(),
  /** IP address of the router that told the collector. */
  peer: z.string().max(64),
  /** That router's network number. RIS sends it as a string. */
  peer_asn: z.string().regex(/^\d{1,10}$/),
  /** Unique per message; our dedupe key. */
  id: z.string().min(1).max(128),
  /** Collector, for example "rrc25.ripe.net". */
  host: z.string().max(64),
  type: z.enum(RIS_MESSAGE_TYPES),
  /** AS path, origin last. A nested array is an AS set. */
  path: z.array(z.union([z.number(), z.array(z.number())])).optional(),
  announcements: z
    .array(z.looseObject({ next_hop: z.string(), prefixes: z.array(z.string().max(64)) }))
    .optional(),
  withdrawals: z.array(z.string().max(64)).optional(),
  /** Only on STATE / RIS_PEER_STATE messages. */
  state: z.string().optional(),
});
export type RisData = z.infer<typeof risDataSchema>;

export const risMessageSchema = z.object({
  type: z.literal('ris_message'),
  data: risDataSchema,
});
export type RisMessage = z.infer<typeof risMessageSchema>;

/** How many of our events one RIS message becomes: one per prefix it mentions. */
export function risEventCount(data: RisData): number {
  if (data.type !== 'UPDATE') return 1;
  let count = data.withdrawals?.length ?? 0;
  for (const a of data.announcements ?? []) count += a.prefixes.length;
  return count;
}

// -------------------------------------------------------------- RIPE Atlas

/** A ping result. `min`/`avg`/`max` are -1 when no packet came back. */
export const atlasPingSchema = z.looseObject({
  type: z.literal('ping'),
  msm_id: z.number().int(),
  prb_id: z.number().int(),
  /** Seconds since the epoch: when the probe ran the measurement. */
  timestamp: z.number().positive(),
  af: z.union([z.literal(4), z.literal(6)]).optional(),
  sent: z.number().int().min(0),
  rcvd: z.number().int().min(0),
  min: z.number(),
  avg: z.number(),
  max: z.number(),
});
export type AtlasPing = z.infer<typeof atlasPingSchema>;

/** A probe connecting to or disconnecting from the Atlas network. */
export const atlasProbeStatusSchema = z.looseObject({
  prb_id: z.number().int(),
  timestamp: z.number().positive(),
  event: z.enum(['connect', 'disconnect']),
  asn: z.number().int().nullable().optional(),
  prefix: z.string().nullable().optional(),
});
export type AtlasProbeStatus = z.infer<typeof atlasProbeStatusSchema>;

/** Atlas frames are `[eventName, payload]` pairs. */
export const atlasFrameSchema = z.tuple([z.string(), z.unknown()]);
