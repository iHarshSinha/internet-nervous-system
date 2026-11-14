import { EV, LIMITS, type Delta, type DeltaValue, type Frame } from '@ins/shared';
import type { LiveNamespace } from './live.ts';
import type { RoomSequencer } from './sequencer.ts';

export interface BroadcasterOptions {
  /** How often staged changes are sent, per room. 0: every change at once, as its own frame. */
  conflateMs?: number;
  /** Frames kept per room for `resync`. */
  ringSize?: number;
  /** "rooms" (default) or "all": the naive baseline that sends every frame to every client. */
  target?: 'rooms' | 'all';
}

/**
 * Sockets in this room are slow clients (see slow.ts): normal frames skip
 * them; they get merged summaries instead. Not a name `sub` accepts.
 */
export const SLOW_ROOM = '~slow';

/**
 * Turns many small changes into few numbered frames, room by room.
 *
 * Producers stage changes as they happen. Every `conflateMs` (500 ms) each
 * room with staged changes gets ONE frame carrying them, with the room's next
 * sequence number. That is the conflation the plan asks for:
 *
 *  - `set` is for a current value (a country's health). Setting it five times
 *    in one interval sends only the last value, and a value equal to the one
 *    last sent (or within `epsilon` of it) is not sent at all. The latest
 *    values are kept, and a client that joins gets them once, in its `sub`
 *    acknowledgement (`state`), so nobody else is sent anything again.
 *  - `append` is for a record that must not be merged away (one closed time
 *    window). Its key is unique, for example "s:1794565823000".
 *
 * Nothing is staged for a room nobody is in, so a quiet country costs nothing.
 * The last `ringSize` frames per room are kept so a client that missed some
 * can ask for them again (`resync`).
 */
export class Broadcaster {
  readonly stats = { frames: 0, deltas: 0, skippedUnchanged: 0 };

  private readonly live: LiveNamespace;
  private readonly seq: RoomSequencer;
  private readonly conflateMs: number;
  private readonly ringSize: number;
  private readonly target: 'rooms' | 'all';
  /** room -> (key + field) -> delta, in staging order. */
  private readonly staged = new Map<string, Map<string, Delta>>();
  /** room -> (key + field) -> the current value last sent, for "send only if changed" and joiners. */
  private readonly lastSent = new Map<string, Map<string, Delta>>();
  /** Staged records (`append`); they are sent once and never kept as current state. */
  private readonly appended = new Set<Delta>();
  private readonly rings = new Map<string, Frame[]>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(live: LiveNamespace, seq: RoomSequencer, opts: BroadcasterOptions = {}) {
    this.live = live;
    this.seq = seq;
    this.conflateMs = opts.conflateMs ?? LIMITS.conflateMs;
    this.ringSize = opts.ringSize ?? LIMITS.ringBufferFrames;
    this.target = opts.target ?? 'rooms';

    // Free memory of rooms that have emptied.
    live.adapter.on('delete-room', (room: string) => {
      this.lastSent.delete(room);
      this.staged.delete(room);
      this.rings.delete(room);
    });
  }

  /** Is anyone in this room? */
  hasMembers(room: string): boolean {
    return (this.live.adapter.rooms.get(room)?.size ?? 0) > 0;
  }

  /** Stage a current value. Sent only if it differs from the last sent by more than `epsilon`. */
  set(room: string, key: string, field: string, value: DeltaValue, epsilon = 0): void {
    if (!this.hasMembers(room)) return;
    const id = `${key}\u0000${field}`;
    const last = this.lastSent.get(room)?.get(id)?.[2];
    const unchanged =
      last === value ||
      (epsilon > 0 &&
        typeof last === 'number' &&
        typeof value === 'number' &&
        Math.abs(last - value) < epsilon);
    if (unchanged) {
      this.stats.skippedUnchanged += 1;
      return;
    }
    this.stage(room).set(id, [key, field, value]);
    if (this.conflateMs === 0) this.flush();
  }

  /** Stage a record that is always sent (its key must be unique). */
  append(room: string, key: string, field: string, value: DeltaValue): void {
    if (!this.hasMembers(room)) return;
    const delta: Delta = [key, field, value];
    this.appended.add(delta);
    this.stage(room).set(`${key}\u0000${field}`, delta);
    if (this.conflateMs === 0) this.flush();
  }

  /**
   * The room's current values (everything `set` and sent so far), for a
   * client joining now. Together with the sequence number read in the same
   * tick, it is a complete starting point.
   */
  state(room: string): Delta[] {
    return [...(this.lastSent.get(room)?.values() ?? [])];
  }

  /** Stop keeping a value (for example an incident that resolved long ago). */
  forget(room: string, key: string, field: string): void {
    this.lastSent.get(room)?.delete(`${key}\u0000${field}`);
  }

  private stage(room: string): Map<string, Delta> {
    let changes = this.staged.get(room);
    if (!changes) {
      changes = new Map();
      this.staged.set(room, changes);
    }
    return changes;
  }

  /** Send one frame per room that has staged changes. */
  flush(now = Date.now()): void {
    for (const [room, changes] of this.staged) {
      this.staged.delete(room);
      if (changes.size === 0 || !this.hasMembers(room)) {
        for (const delta of changes.values()) this.appended.delete(delta);
        continue;
      }

      const d = [...changes.values()];
      const frame: Frame = { r: room, s: this.seq.next(room), t: now, d };

      let sent = this.lastSent.get(room);
      if (!sent) {
        sent = new Map();
        this.lastSent.set(room, sent);
      }
      for (const [id, delta] of changes) {
        if (this.appended.delete(delta)) continue; // records are not current state
        sent.set(id, delta);
      }

      let ring = this.rings.get(room);
      if (!ring) {
        ring = [];
        this.rings.set(room, ring);
      }
      ring.push(frame);
      if (ring.length > this.ringSize) ring.shift();

      // Slow clients are skipped here; they get the same frames merged, every 2 s.
      if (this.target === 'all') this.live.except(SLOW_ROOM).emit(EV.frame, frame);
      else this.live.to(room).except(SLOW_ROOM).emit(EV.frame, frame);
      this.stats.frames += 1;
      this.stats.deltas += d.length;
    }
    // Everything staged has been handled (sent or dropped).
    this.appended.clear();
  }

  /**
   * Frames of `room` after sequence number `after`, for a client that saw a
   * gap. Returns null when some of them have already left the ring buffer;
   * the client must then fetch a fresh snapshot from the history API.
   */
  since(room: string, after: number): Frame[] | null {
    if (after >= this.seq.current(room)) return [];
    const ring = this.rings.get(room) ?? [];
    const oldest = ring[0];
    if (!oldest || oldest.s > after + 1) return null;
    return ring.filter((frame) => frame.s > after);
  }

  /**
   * One frame that merges every frame of `room` after `after`: for each key
   * and field only the latest value, records kept. It carries `f`, the first
   * sequence number it covers, so the client accepts it as the next step.
   * Null when those frames have left the ring buffer (the client will resync
   * and then reload), undefined when there is nothing new.
   */
  summary(room: string, after: number): Frame | null | undefined {
    const frames = this.since(room, after);
    if (frames === null) return null;
    if (frames.length === 0) return undefined;
    const merged = new Map<string, Delta>();
    for (const frame of frames) {
      for (const delta of frame.d) {
        const id = `${delta[0]}\u0000${delta[1]}`;
        merged.delete(id); // re-insert, so the order follows the latest change
        merged.set(id, delta);
      }
    }
    const last = frames.at(-1)!;
    return { r: room, s: last.s, t: last.t, d: [...merged.values()], f: frames[0]!.s };
  }

  start(): void {
    if (this.conflateMs > 0) this.timer ??= setInterval(() => this.flush(), this.conflateMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
