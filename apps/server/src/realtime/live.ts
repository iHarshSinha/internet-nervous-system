import {
  EV,
  LIMITS,
  NAMESPACES,
  namespaceOf,
  parseRoom,
  subPayloadSchema,
  unsubPayloadSchema,
  type AckError,
  type ClientToServerEvents,
  type ErrorCode,
  type ServerToClientEvents,
  type SubAck,
  type UnsubAck,
} from '@ins/shared';
import type { Namespace, Server } from 'socket.io';
import type { Logger } from '../logger.ts';
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
export function attachLive(io: IoServer, seq: RoomSequencer, log: Logger): LiveNamespace {
  const live: LiveNamespace = io.of(NAMESPACES.live);

  live.on('connection', (socket) => {
    log.debug({ id: socket.id, recovered: socket.recovered }, 'live socket connected');

    // Payloads come from the network, so they are `unknown` until zod has checked them.
    socket.on(EV.sub, (raw: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      const reply = ack as (r: SubAck) => void;

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
      const parsed = unsubPayloadSchema.safeParse(raw);
      if (!parsed.success) return reply(fail('bad_request', 'Invalid unsubscription'));
      for (const name of parsed.data.rooms) void socket.leave(name);
      reply({ ok: true });
    });
  });

  return live;
}
