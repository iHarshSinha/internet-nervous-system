import {
  EV,
  NAMESPACES,
  type ClientToServerEvents,
  type Frame,
  type ServerToClientEvents,
} from '@ins/shared';
import { expose } from 'comlink';
import { io, type Socket } from 'socket.io-client';
import { RoomSync } from '../realtime/roomSync.ts';

/*
 * The socket lives in this Web Worker, not on the page's main thread. Decoding
 * messages and checking sequence numbers happen here, so a burst of frames
 * can never make scrolling or the globe stutter. The page receives at most one
 * merged update per animation frame (~16 ms), however many frames arrived.
 */

export type LinkStatus = 'connecting' | 'live' | 'reconnecting';

export interface LinkStats {
  /** Frames applied. */
  received: number;
  /** Frames dropped because their sequence number had already been seen. */
  duplicates: number;
  /** Times a sequence number was skipped. */
  gaps: number;
  /** Times missing frames were fetched again with `resync`. */
  resyncs: number;
  /** Times missing frames were too old to fetch again. */
  tooOld: number;
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
const syncs = new Map<string, RoomSync>(); // per room: ordering, duplicates, gaps

function totals(): LinkStats {
  const t: LinkStats = { received: 0, duplicates: 0, gaps: 0, resyncs: 0, tooOld: 0 };
  for (const sync of syncs.values()) {
    t.received += sync.stats.applied;
    t.duplicates += sync.stats.duplicates;
    t.gaps += sync.stats.gaps;
    t.resyncs += sync.stats.resyncs;
    t.tooOld += sync.stats.tooOld;
  }
  return t;
}

function flush(): void {
  flushTimer = null;
  const frames = pending;
  pending = [];
  listener?.({ status, frames, stats: totals() });
}

function scheduleFlush(): void {
  flushTimer ??= setTimeout(flush, FLUSH_MS);
}

function setStatus(next: LinkStatus): void {
  status = next;
  scheduleFlush();
}

/** Queue frames for the page, and ask for a resync if the room has a gap. */
function handle(room: string, result: ReturnType<RoomSync['receive']>): void {
  if (result.apply.length > 0) {
    pending.push(...result.apply);
    scheduleFlush();
  }
  if (result.resyncAfter !== undefined && socket?.connected) {
    socket.emit(EV.resync, { r: room, after: result.resyncAfter }, (ack) => {
      const sync = syncs.get(room);
      if (!sync) return;
      // Phase 1 step 5 reloads history for a stale room; for now it is counted.
      handle(room, sync.resynced(ack.ok ? ack.frames : null));
    });
  }
}

function onFrame(frame: Frame): void {
  const sync = syncs.get(frame.r);
  if (sync) handle(frame.r, sync.receive(frame));
}

function join(roomNames: string[]): Promise<Record<string, number>> {
  if (!socket?.connected || roomNames.length === 0) return Promise.resolve({});
  // A fresh start for each room: frames are held until the server says
  // where the stream begins.
  for (const room of roomNames) syncs.set(room, new RoomSync());
  const s = socket;
  return new Promise((resolve) =>
    s.emit(EV.sub, { rooms: roomNames }, (ack) => {
      if (!ack.ok) return resolve({});
      // The server's current sequence number is our starting point: the next
      // frame for each room must be exactly one more.
      for (const [room, seq] of Object.entries(ack.seqs)) {
        const sync = syncs.get(room);
        if (sync) handle(room, sync.start(seq));
      }
      resolve(ack.seqs);
    }),
  );
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
      if (!socket?.recovered) void join([...wanted]);
    });
    socket.on('disconnect', () => setStatus('reconnecting'));
    socket.on(EV.frame, onFrame);
  },

  /** Join rooms. Resolves with each room's current sequence number (the merge starting point). */
  subscribe(roomNames: string[]): Promise<Record<string, number>> {
    const fresh = roomNames.filter((room) => !wanted.has(room));
    for (const room of fresh) wanted.add(room);
    return join(fresh);
  },

  unsubscribe(roomNames: string[]): void {
    for (const room of roomNames) {
      wanted.delete(room);
      syncs.delete(room);
    }
    if (socket?.connected) socket.emit(EV.unsub, { rooms: roomNames }, () => {});
  },
};

export type SocketWorkerApi = typeof api;

expose(api);
