import {
  EV,
  NAMESPACES,
  type ClientToServerEvents,
  type FeedBatch,
  type Frame,
  type RealtimeConfig,
  type ServerToClientEvents,
} from '@ins/shared';
import { expose } from 'comlink';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
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

/** The personal `/user` channel: off when signed out. */
export type UserChannel = 'off' | 'connecting' | 'live' | 'refused';

export interface WorkerUpdate {
  status: LinkStatus;
  user: UserChannel;
  /** Frames accepted since the previous update, in order. */
  frames: Frame[];
  /** Firehose samples received since the previous update (feed rooms only). */
  feed: FeedBatch[];
  stats: LinkStats;
}

type Listener = (update: WorkerUpdate) => void;

const FLUSH_MS = 16;

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let listener: Listener | null = null;
let status: LinkStatus = 'connecting';
let userSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let userChannel: UserChannel = 'off';
let pending: Frame[] = [];
let pendingFeed: FeedBatch[] = [];

/*
 * The server says which wire format it speaks (MessagePack unless switched
 * off for a measurement). Both sockets wait for the answer before connecting.
 */
const options: Promise<Partial<ManagerOptions & SocketOptions>> = fetch('/api/realtime')
  .then((res) => (res.ok ? (res.json() as Promise<RealtimeConfig>) : null))
  .catch(() => null)
  .then((config) => ({
    transports: ['websocket'],
    ...(config?.parser !== 'json' && { parser: msgpackParser }),
  }));
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
  const feed = pendingFeed;
  pending = [];
  pendingFeed = [];
  listener?.({ status, user: userChannel, frames, feed, stats: totals() });
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
      // frame for each room must be exactly one more. The room's current values
      // at that number come with the acknowledgement, as one frame.
      for (const [room, seq] of Object.entries(ack.seqs)) {
        const sync = syncs.get(room);
        if (!sync) continue;
        const state = ack.state?.[room];
        if (state && state.length > 0) {
          pending.push({ r: room, s: seq, t: ack.t, d: state });
          scheduleFlush();
        }
        handle(room, sync.start(seq));
      }
      resolve(ack.seqs);
    }),
  );
}

const api = {
  /** Open the connection. `onUpdate` is called with batched updates. */
  async start(onUpdate: Listener): Promise<void> {
    if (socket || listener) return;
    listener = onUpdate;

    // A relative URL: the page, the API and the socket share one origin.
    socket = io(NAMESPACES.live, await options);

    socket.on('connect', () => {
      setStatus('live');
      // After a short drop Socket.IO restores our rooms and replays what we
      // missed. Otherwise (first connect, long drop, server restart) rejoin.
      if (!socket?.recovered) void join([...wanted]);
    });
    socket.on('disconnect', () => setStatus('reconnecting'));
    socket.on(EV.frame, onFrame);
    // Firehose samples are not numbered (they are a sample, sent volatile): pass them on.
    socket.on(EV.feed, (batch) => {
      if (!wanted.has(batch.r)) return;
      pendingFeed.push(batch);
      scheduleFlush();
    });
  },

  /**
   * Open (or update, or close with null) the personal `/user` channel. The
   * server checks the access token in the handshake; when the token is
   * renewed, the next reconnect uses the new one.
   */
  async connectUser(token: string | null): Promise<void> {
    const opts = await options;
    if (!token) {
      userSocket?.close();
      userSocket = null;
      userChannel = 'off';
      scheduleFlush();
      return;
    }
    if (userSocket) {
      userSocket.auth = { token };
      return;
    }
    userChannel = 'connecting';
    userSocket = io(NAMESPACES.user, { ...opts, auth: { token } });
    userSocket.on('connect', () => {
      userChannel = 'live';
      scheduleFlush();
    });
    userSocket.on('disconnect', () => {
      userChannel = 'connecting';
      scheduleFlush();
    });
    userSocket.on('connect_error', () => {
      userChannel = 'refused';
      scheduleFlush();
    });
    // Personal alerts arrive here as frames for the `user:<id>` room (Phase 2).
    userSocket.on(EV.frame, (frame) => {
      pending.push(frame);
      scheduleFlush();
    });
    scheduleFlush();
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
