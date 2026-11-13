import {
  checkSeq,
  EV,
  NAMESPACES,
  type ClientToServerEvents,
  type Frame,
  type ServerToClientEvents,
} from '@ins/shared';
import { expose } from 'comlink';
import { io, type Socket } from 'socket.io-client';

/*
 * The socket lives in this Web Worker, not on the page's main thread. Decoding
 * messages and checking sequence numbers happen here, so a burst of frames
 * can never make scrolling or the globe stutter. The page receives at most one
 * merged update per animation frame (~16 ms), however many frames arrived.
 */

export type LinkStatus = 'connecting' | 'live' | 'reconnecting';

export interface LinkStats {
  /** Frames accepted. */
  received: number;
  /** Frames dropped because their sequence number had already been seen. */
  duplicates: number;
  /** Times a sequence number was skipped. */
  gaps: number;
}

export interface WorkerUpdate {
  status: LinkStatus;
  /** Frames accepted since the previous update, in order. */
  frames: Frame[];
  stats: LinkStats;
}

type Listener = (update: WorkerUpdate) => void;

const FLUSH_MS = 16;

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let listener: Listener | null = null;
let status: LinkStatus = 'connecting';
let pending: Frame[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const wanted = new Set<string>(); // rooms the page asked for
const lastSeq = new Map<string, number>(); // last sequence number applied, per room
const stats: LinkStats = { received: 0, duplicates: 0, gaps: 0 };

function flush(): void {
  flushTimer = null;
  const frames = pending;
  pending = [];
  listener?.({ status, frames, stats: { ...stats } });
}

function scheduleFlush(): void {
  flushTimer ??= setTimeout(flush, FLUSH_MS);
}

function setStatus(next: LinkStatus): void {
  status = next;
  scheduleFlush();
}

function onFrame(frame: Frame): void {
  const last = lastSeq.get(frame.r);
  const verdict = last === undefined ? 'next' : checkSeq(last, frame.s);
  if (verdict === 'duplicate') {
    stats.duplicates += 1;
    return;
  }
  // Phase 1 answers a gap with `resync`; for now it is counted and shown.
  if (verdict === 'gap') stats.gaps += 1;

  lastSeq.set(frame.r, frame.s);
  stats.received += 1;
  pending.push(frame);
  scheduleFlush();
}

function join(roomNames: string[]): void {
  if (!socket?.connected || roomNames.length === 0) return;
  socket.emit(EV.sub, { rooms: roomNames }, (ack) => {
    if (!ack.ok) return;
    // The server's current sequence number is our starting point: the next
    // frame for each room must be exactly one more.
    for (const [room, seq] of Object.entries(ack.seqs)) lastSeq.set(room, seq);
  });
}

const api = {
  /** Open the connection. `onUpdate` is called with batched updates. */
  start(onUpdate: Listener): void {
    if (socket) return;
    listener = onUpdate;

    // A relative URL: the page, the API and the socket share one origin.
    socket = io(NAMESPACES.live, { transports: ['websocket'] });

    socket.on('connect', () => {
      setStatus('live');
      // After a short drop Socket.IO restores our rooms and replays what we
      // missed. Otherwise (first connect, long drop, server restart) rejoin.
      if (!socket?.recovered) join([...wanted]);
    });
    socket.on('disconnect', () => setStatus('reconnecting'));
    socket.on(EV.frame, onFrame);
  },

  subscribe(roomNames: string[]): void {
    const fresh = roomNames.filter((room) => !wanted.has(room));
    for (const room of fresh) wanted.add(room);
    join(fresh);
  },

  unsubscribe(roomNames: string[]): void {
    for (const room of roomNames) {
      wanted.delete(room);
      lastSeq.delete(room);
    }
    if (socket?.connected) socket.emit(EV.unsub, { rooms: roomNames }, () => {});
  },
};

export type SocketWorkerApi = typeof api;

expose(api);
