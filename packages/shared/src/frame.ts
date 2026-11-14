import { z } from 'zod';
import { LIMITS } from './constants.ts';
import { epochMsSchema, seqSchema } from './primitives.ts';
import { roomSchema } from './rooms.ts';

/** A changed value: a primitive, or a small JSON object or array (used by incidents). */
export const deltaValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
export type DeltaValue = z.infer<typeof deltaValueSchema>;

/**
 * One change: `[key, field, value]`, for example `["IN", "health", 87]`.
 * A compact array instead of an object, so field names are not repeated on the wire.
 */
export const deltaSchema = z.tuple([z.string().max(128), z.string().max(32), deltaValueSchema]);
export type Delta = z.infer<typeof deltaSchema>;

/**
 * What the server sends to a room. It carries changes only, never full state.
 *
 * - `r` room, `s` sequence number (goes up by exactly 1 per frame per room),
 * - `t` server time in ms, `d` the list of changes.
 */
export const frameSchema = z.object({
  r: roomSchema,
  s: seqSchema,
  t: epochMsSchema,
  d: z.array(deltaSchema).max(LIMITS.maxDeltasPerFrame),
  /**
   * Only on a summary for a slow client: the frame merges frames `f` to `s`
   * (later values of the same key and field win). A normal frame covers just `s`.
   */
  f: seqSchema.optional(),
});
export type Frame = z.infer<typeof frameSchema>;

export type SeqCheck = 'next' | 'duplicate' | 'gap';

/**
 * Compare an incoming frame's sequence number with the last one applied.
 *
 * - `next`: exactly one more, so apply it.
 * - `duplicate`: already seen (or covered by a snapshot), so drop it.
 * - `gap`: at least one frame is missing, so ask the server to `resync`.
 */
export function checkSeq(lastApplied: number, incoming: number, from = incoming): SeqCheck {
  if (incoming <= lastApplied) return 'duplicate';
  // A summary covering f..s continues the stream if it starts at or before the next number.
  // Any overlap is harmless: values are set again, records have unique keys.
  return from <= lastApplied + 1 ? 'next' : 'gap';
}
