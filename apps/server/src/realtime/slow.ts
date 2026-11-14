import { EV, LIMITS } from '@ins/shared';
import type { Logger } from '../logger.ts';
import { SLOW_ROOM, type Broadcaster } from './broadcaster.ts';
import type { LiveNamespace } from './live.ts';
import type { RoomSequencer } from './sequencer.ts';

type LiveSocket = ReturnType<LiveNamespace['sockets']['get']> & object;

/** What is waiting to be sent to one client: packets queued in Engine.IO and bytes in the socket. */
export interface Backlog {
  packets: number;
  bytes: number;
}

/** Read a socket's send backlog from Engine.IO and the underlying WebSocket. */
export function backlogOf(socket: LiveSocket): Backlog {
  const conn = socket.conn as unknown as {
    writeBuffer?: unknown[];
    transport?: { socket?: { bufferedAmount?: number } };
  };
  return {
    packets: conn.writeBuffer?.length ?? 0,
    bytes: conn.transport?.socket?.bufferedAmount ?? 0,
  };
}

export interface SlowOptions {
  log: Logger;
  /** How often a slow client gets its merged frames. */
  summaryMs?: number;
  /** How often every client's backlog is checked. */
  checkMs?: number;
  /** Overridable in tests, which cannot make a real socket slow on demand. */
  backlog?(socket: LiveSocket): Backlog;
}

// Slow: over either limit at two checks in a row. Recovered: under the small
// limits at five checks in a row. The gap between them stops a client on the
// edge from flapping between the two modes.
const SLOW = { packets: 64, bytes: 256 * 1024 };
const CALM = { packets: 4, bytes: 16 * 1024 };
const STRIKES_TO_DOWNGRADE = 2;
const CALM_TO_RECOVER = 5;

/**
 * Slow-client downgrade.
 *
 * A browser on a bad connection (or a busy phone) cannot always take a frame
 * every 500 ms per room. Socket.IO would keep queueing them, the backlog
 * would grow without limit, and that client would fall further and further
 * behind. So once a second every `/live` socket's send backlog is checked;
 * a client that stays behind is moved to SLOW_ROOM. Normal frames skip that
 * room, and every 2 s the client gets ONE frame per room that merges what it
 * missed (latest value per key, records kept), marked with the range of
 * sequence numbers it covers. Once its backlog has drained it returns to
 * normal frames, after a last summary so nothing is skipped.
 */
export class SlowClients {
  readonly stats = { downgrades: 0, recoveries: 0, summaries: 0, slowNow: 0 };

  private readonly live: LiveNamespace;
  private readonly broadcaster: Broadcaster;
  private readonly seq: RoomSequencer;
  private readonly opts: SlowOptions;
  private readonly backlog: (socket: LiveSocket) => Backlog;
  /** Slow sockets: per room, the last sequence number this client has been sent. */
  private readonly slow = new Map<string, { sentUpTo: Map<string, number>; calm: number }>();
  private readonly strikes = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    live: LiveNamespace,
    broadcaster: Broadcaster,
    seq: RoomSequencer,
    opts: SlowOptions,
  ) {
    this.live = live;
    this.broadcaster = broadcaster;
    this.seq = seq;
    this.opts = opts;
    this.backlog = opts.backlog ?? backlogOf;

    // A slow client joining a room starts from that room's current number,
    // exactly like the `sub` acknowledgement it receives.
    live.adapter.on('join-room', (room: string, id: string) => {
      this.slow.get(id)?.sentUpTo.set(room, this.seq.current(room));
    });
  }

  start(): void {
    if (this.timers.length > 0) return;
    this.timers.push(
      setInterval(() => this.check(), this.opts.checkMs ?? 1000),
      setInterval(() => this.summarise(), this.opts.summaryMs ?? LIMITS.slowClientSummaryMs),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  isSlow(id: string): boolean {
    return this.slow.has(id);
  }

  /** Look at every client's backlog; downgrade or restore. */
  check(): void {
    for (const socket of this.live.sockets.values()) {
      const b = this.backlog(socket);
      const state = this.slow.get(socket.id);
      if (!state) {
        const over = b.packets > SLOW.packets || b.bytes > SLOW.bytes;
        const strikes = over ? (this.strikes.get(socket.id) ?? 0) + 1 : 0;
        if (strikes >= STRIKES_TO_DOWNGRADE) this.downgrade(socket, b);
        else if (strikes > 0) this.strikes.set(socket.id, strikes);
        else this.strikes.delete(socket.id);
      } else {
        const calm = b.packets <= CALM.packets && b.bytes <= CALM.bytes;
        state.calm = calm ? state.calm + 1 : 0;
        if (state.calm >= CALM_TO_RECOVER) this.restore(socket);
      }
    }
    // Forget sockets that have gone.
    for (const id of [...this.slow.keys(), ...this.strikes.keys()]) {
      if (!this.live.sockets.has(id)) {
        this.slow.delete(id);
        this.strikes.delete(id);
      }
    }
    this.stats.slowNow = this.slow.size;
  }

  /** Send every slow client one merged frame per room it is in. */
  summarise(): void {
    for (const [id, state] of this.slow) {
      const socket = this.live.sockets.get(id);
      if (socket) this.summariseOne(socket, state.sentUpTo);
    }
  }

  private summariseOne(socket: LiveSocket, sentUpTo: Map<string, number>): void {
    for (const room of socket.rooms) {
      if (room === socket.id || room === SLOW_ROOM) continue;
      const after = sentUpTo.get(room) ?? this.seq.current(room);
      const frame = this.broadcaster.summary(room, after);
      if (frame === undefined) {
        sentUpTo.set(room, after);
        continue;
      }
      if (frame === null) {
        // Too far behind for the ring buffer: skip ahead. The client sees a gap,
        // asks for a resync, is told it is too old, and reloads that room's history.
        sentUpTo.set(room, this.seq.current(room));
        continue;
      }
      socket.emit(EV.frame, frame);
      sentUpTo.set(room, frame.s);
      this.stats.summaries += 1;
    }
  }

  private downgrade(socket: LiveSocket, b: Backlog): void {
    this.strikes.delete(socket.id);
    // Everything up to now is already in this client's send buffer.
    const sentUpTo = new Map<string, number>();
    for (const room of socket.rooms) sentUpTo.set(room, this.seq.current(room));
    this.slow.set(socket.id, { sentUpTo, calm: 0 });
    void socket.join(SLOW_ROOM);
    this.stats.downgrades += 1;
    this.opts.log.info({ id: socket.id, ...b }, 'slow client: switched to 2-second summaries');
  }

  private restore(socket: LiveSocket): void {
    const state = this.slow.get(socket.id)!;
    // Catch up first, then rejoin normal frames in the same tick: the next
    // normal frame is exactly one after the summary.
    this.summariseOne(socket, state.sentUpTo);
    this.slow.delete(socket.id);
    void socket.leave(SLOW_ROOM);
    this.stats.recoveries += 1;
    this.opts.log.info({ id: socket.id }, 'slow client: back to normal frames');
  }
}
