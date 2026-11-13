import { z } from 'zod';
import { LIMITS, SEVERITIES } from './constants.ts';
import { frameSchema, type Frame } from './frame.ts';
import { epochMsSchema, seqSchema } from './primitives.ts';
import { roomSchema } from './rooms.ts';

/** Socket.IO event names. `f` is one letter because it is sent with every frame. */
export const EV = {
  frame: 'f',
  sub: 'sub',
  unsub: 'unsub',
  resync: 'resync',
} as const;

const roomListSchema = z.array(roomSchema).min(1).max(LIMITS.maxRoomsPerSocket);

/** Optional per-client filters applied by the server before it sends. */
export const subFiltersSchema = z.object({
  withdrawalsOnly: z.boolean().optional(),
  ipv6Only: z.boolean().optional(),
  minSeverity: z.enum(SEVERITIES).optional(),
});
export type SubFilters = z.infer<typeof subFiltersSchema>;

/** Client → server: join rooms. */
export const subPayloadSchema = z.object({
  rooms: roomListSchema,
  filters: subFiltersSchema.optional(),
});
export type SubPayload = z.infer<typeof subPayloadSchema>;

/** Client → server: leave rooms. */
export const unsubPayloadSchema = z.object({ rooms: roomListSchema });
export type UnsubPayload = z.infer<typeof unsubPayloadSchema>;

/** Client → server: "I am missing frames in room `r`; send everything after `after`." */
export const resyncPayloadSchema = z.object({ r: roomSchema, after: seqSchema });
export type ResyncPayload = z.infer<typeof resyncPayloadSchema>;

export const ERROR_CODES = [
  'bad_request', // payload failed validation
  'forbidden', // room is not available in this namespace or to this role
  'too_many_rooms', // would exceed LIMITS.maxRoomsPerSocket
  'rate_limited', // token bucket empty
  'gap_too_old', // missing frames have left the ring buffer; fetch a fresh snapshot
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const ackErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }),
});
export type AckError = z.infer<typeof ackErrorSchema>;

/**
 * Reply to `sub`. `seqs` holds each joined room's current sequence number.
 * The client uses it as the starting point of the history-plus-live merge.
 */
export const subAckSchema = z.union([
  z.object({
    ok: z.literal(true),
    seqs: z.record(z.string(), seqSchema),
    t: epochMsSchema,
  }),
  ackErrorSchema,
]);
export type SubAck = z.infer<typeof subAckSchema>;

export const unsubAckSchema = z.union([z.object({ ok: z.literal(true) }), ackErrorSchema]);
export type UnsubAck = z.infer<typeof unsubAckSchema>;

/** Reply to `resync`: the missing frames, in order. */
export const resyncAckSchema = z.union([
  z.object({ ok: z.literal(true), frames: z.array(frameSchema) }),
  ackErrorSchema,
]);
export type ResyncAck = z.infer<typeof resyncAckSchema>;

/** Typed event maps, passed to Socket.IO's `Server` and `Socket` generics on both sides. */
export interface ServerToClientEvents {
  f: (frame: Frame) => void;
}

export interface ClientToServerEvents {
  sub: (payload: SubPayload, ack: (reply: SubAck) => void) => void;
  unsub: (payload: UnsubPayload, ack: (reply: UnsubAck) => void) => void;
  resync: (payload: ResyncPayload, ack: (reply: ResyncAck) => void) => void;
}
