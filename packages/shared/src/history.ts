import { z } from 'zod';
import { epochMsSchema, seqSchema } from './primitives.ts';
import { parseRoom, rooms } from './rooms.ts';

export const HISTORY_SCOPES = ['world', 'country', 'asn'] as const;
export type HistoryScope = (typeof HISTORY_SCOPES)[number];

/** The room whose live frames continue a given history series. */
export function roomForScope(scope: HistoryScope, key: string): string {
  if (scope === 'world') return rooms.world;
  return scope === 'country' ? rooms.country(key) : rooms.asn(Number(key));
}

/**
 * Query string of `GET /api/history`. Values arrive as strings, so numbers are coerced.
 * `key` is a country code or an ASN; for `world` it is ignored and may be omitted.
 */
export const historyQuerySchema = z
  .object({
    scope: z.enum(HISTORY_SCOPES),
    key: z.string().max(16).default(''),
    from: z.coerce.number().pipe(epochMsSchema),
    to: z.coerce.number().pipe(epochMsSchema).optional(),
  })
  .refine((q) => q.scope === 'world' || parseRoom(roomForScope(q.scope, q.key)) !== null, {
    path: ['key'],
    message: 'key must be a country code or an ASN matching the scope',
  })
  .refine((q) => q.to === undefined || q.to > q.from, {
    path: ['to'],
    message: '"to" must be later than "from"',
  });
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/**
 * One point of a metric series. The same short field names are used as the
 * `field` of live deltas, so history and live data share one vocabulary.
 */
export const metricPointSchema = z.object({
  /** Start of the window, in ms. Points are keyed by this, which makes merging idempotent. */
  t: epochMsSchema,
  /** Route announcements. */
  ann: z.number().int().min(0),
  /** Route withdrawals. */
  wd: z.number().int().min(0),
  /** Distinct prefixes withdrawn. */
  pfx: z.number().int().min(0),
  /** Round-trip time percentiles in ms; null when no probe reported. */
  p50: z.number().min(0).nullable(),
  p95: z.number().min(0).nullable(),
  /** Probes connected and disconnected. */
  up: z.number().int().min(0),
  down: z.number().int().min(0),
  /** Health score, 0 (down) to 100 (healthy). */
  health: z.number().min(0).max(100),
  /** Events that arrived after their window had closed. */
  late: z.number().int().min(0),
});
export type MetricPoint = z.infer<typeof metricPointSchema>;

/**
 * Reply of `GET /api/history`.
 *
 * `snapshotSeq` is the last frame of the matching room that is already
 * included in this data. The client drops buffered frames up to and including
 * it, then applies the rest: no gap, no duplicate.
 */
export const historyResponseSchema = z.object({
  scope: z.enum(HISTORY_SCOPES),
  key: z.string(),
  room: z.string(),
  snapshotSeq: seqSchema,
  serverTime: epochMsSchema,
  /** 1-minute points from MongoDB. */
  minutes: z.array(metricPointSchema),
  /** 1-second points from server memory (most recent 15 minutes). */
  seconds: z.array(metricPointSchema),
});
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
