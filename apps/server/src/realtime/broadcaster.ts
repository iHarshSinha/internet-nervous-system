import { EV, LIMITS, type Delta, type DeltaValue, type Frame } from '@ins/shared';
import type { LiveNamespace } from './live.ts';
import type { RoomSequencer } from './sequencer.ts';

export interface BroadcasterOptions {
  /** How often staged changes are sent, per room. */
  conflateMs?: number;
  /** Frames kept per room for `resync`. */
  ringSize?: number;
}

/**
 * Turns many small changes into few numbered frames, room by room.
 *
 * Producers stage changes as they happen. Every `conflateMs` (500 ms) each
 * room with staged changes gets ONE frame carrying them, with the room's next
 * sequence number. That is the conflation the plan asks for:
 *
 *  - `set` is for a current value (a country's health). Setting it five times
 *    in one interval sends only the last value, and a value equal to the one
 *    last sent (or within `epsilon` of it) is not sent at all.
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
  /** room -> (key + field) -> delta, in staging order. */
  private readonly staged = new Map<string, Map<string, Delta>>();
  /** room -> (key + field) -> value last sent, for "send only if changed". */
  private readonly lastSent = new Map<string, Map<string, DeltaValue>>();
  private readonly rings = new Map<string, Frame[]>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(live: LiveNamespace, seq: RoomSequencer, opts: BroadcasterOptions = {}) {
    this.live = live;
    this.seq = seq;
    this.conflateMs = opts.conflateMs ?? LIMITS.conflateMs;
    this.ringSize = opts.ringSize ?? LIMITS.ringBufferFrames;

    // Someone new in a room has none of its current values yet. Forget what
    // was last sent there, so the next `set` of every value goes out again.
    live.adapter.on('join-room', (room: string) => this.lastSent.delete(room));
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
    const last = this.lastSent.get(room)?.get(id);
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
  }

  /** Stage a record that is always sent (its key must be unique). */
  append(room: string, key: string, field: string, value: DeltaValue): void {
    if (!this.hasMembers(room)) return;
    this.stage(room).set(`${key}\u0000${field}`, [key, field, value]);
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
      if (changes.size === 0 || !this.hasMembers(room)) continue;

      const d = [...changes.values()];
      const frame: Frame = { r: room, s: this.seq.next(room), t: now, d };

      let sent = this.lastSent.get(room);
      if (!sent) {
        sent = new Map();
        this.lastSent.set(room, sent);
      }
      for (const [id, delta] of changes) sent.set(id, delta[2]);

      let ring = this.rings.get(room);
      if (!ring) {
        ring = [];
        this.rings.set(room, ring);
      }
      ring.push(frame);
      if (ring.length > this.ringSize) ring.shift();

      this.live.to(room).emit(EV.frame, frame);
      this.stats.frames += 1;
      this.stats.deltas += d.length;
    }
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

  start(): void {
    this.timer ??= setInterval(() => this.flush(), this.conflateMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
