import {
  EV,
  LIMITS,
  NAMESPACES,
  namespaceOf,
  parseRoom,
  resyncPayloadSchema,
  subPayloadSchema,
  unsubPayloadSchema,
  type AckError,
  type ClientToServerEvents,
  type ErrorCode,
  type ResyncAck,
  type ServerToClientEvents,
  type SubAck,
  type UnsubAck,
} from '@ins/shared';
import type { Namespace, Server } from 'socket.io';
import type { Logger } from '../logger.ts';
import type { Broadcaster } from './broadcaster.ts';
import { TokenBucket } from './limits.ts';
import type { RoomSequencer } from './sequencer.ts';

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type LiveNamespace = Namespace<ClientToServerEvents, ServerToClientEvents>;

const fail = (code: ErrorCode, message: string): AckError => ({
  ok: false,
  error: { code, message },
});

/**
 * The public `/live` namespace. Anyone may connect; a client receives nothing
 * until it subscribes to rooms, and then only what those rooms carry.
 */
export function attachLive(io: IoServer): LiveNamespace {
  return io.of(NAMESPACES.live);
}

/** Handle what clients send on `/live`: sub, unsub and resync. */
export function handleLive(
  live: LiveNamespace,
  seq: RoomSequencer,
  broadcaster: Broadcaster,
  log: Logger,
  messagesPerSec: number = LIMITS.socketMessagesPerSecond,
): void {
  live.on('connection', (socket) => {
    log.debug({ id: socket.id, recovered: socket.recovered }, 'live socket connected');

    // sub, unsub and resync share one token bucket per socket (5 per second by
    // default). A client that keeps hitting the limit is disconnected.
    const bucket = new TokenBucket(messagesPerSec, Math.max(1, Math.ceil(messagesPerSec)));
    let strikes = 0;
    const allowed = (reply: (r: AckError) => void): boolean => {
      if (bucket.take()) return true;
      strikes += 1;
      reply(fail('rate_limited', 'Too many requests on this socket'));
      if (strikes > 20) {
        log.warn({ id: socket.id }, 'disconnecting a socket that kept exceeding its rate limit');
        socket.disconnect(true);
      }
      return false;
    };

    // Payloads come from the network, so they are `unknown` until zod has checked them.
    socket.on(EV.sub, (raw: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      const reply = ack as (r: SubAck) => void;
      if (!allowed(reply)) return;

      const parsed = subPayloadSchema.safeParse(raw);
      if (!parsed.success) return reply(fail('bad_request', 'Invalid subscription'));

      // A room name can be valid and still belong to another namespace (user:<id>, ops).
      const wanted = [...new Set(parsed.data.rooms)];
      const foreign = wanted.find((name) => {
        const room = parseRoom(name);
        return room === null || namespaceOf(room) !== NAMESPACES.live;
      });
      if (foreign !== undefined) return reply(fail('forbidden', `Room not available: ${foreign}`));

      // socket.rooms always contains the socket's own ID, which does not count.
      const joined = socket.rooms.size - 1;
      const added = wanted.filter((name) => !socket.rooms.has(name)).length;
      if (joined + added > LIMITS.maxRoomsPerSocket) {
        return reply(fail('too_many_rooms', `At most ${LIMITS.maxRoomsPerSocket} rooms`));
      }

      // Read the sequence numbers and join in the same tick, with no `await`
      // in between: no frame can be emitted between the two, so the first
      // frame this socket receives for a room is exactly seq + 1.
      const seqs: Record<string, number> = {};
      for (const name of wanted) {
        seqs[name] = seq.current(name);
        void socket.join(name);
      }
      reply({ ok: true, seqs, t: Date.now() });
    });

    socket.on(EV.unsub, (raw: unknown, ack: unknown) => {
      const reply = typeof ack === 'function' ? (ack as (r: UnsubAck) => void) : () => {};
      if (!allowed(reply)) return;
      const parsed = unsubPayloadSchema.safeParse(raw);
      if (!parsed.success) return reply(fail('bad_request', 'Invalid unsubscription'));
      for (const name of parsed.data.rooms) void socket.leave(name);
      reply({ ok: true });
    });

    // "I missed frames in room r after sequence number `after`": send them
    // again from the ring buffer, or say they are gone (the client then
    // fetches a fresh snapshot from the history API).
    socket.on(EV.resync, (raw: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      const reply = ack as (r: ResyncAck) => void;
      if (!allowed(reply)) return;
      const parsed = resyncPayloadSchema.safeParse(raw);
      if (!parsed.success) return reply(fail('bad_request', 'Invalid resync request'));
      const { r, after } = parsed.data;
      if (!socket.rooms.has(r)) return reply(fail('forbidden', `Not subscribed to ${r}`));
      const frames = broadcaster.since(r, after);
      if (frames === null) return reply(fail('gap_too_old', 'Fetch a fresh snapshot'));
      reply({ ok: true, frames });
    });
  });
}
