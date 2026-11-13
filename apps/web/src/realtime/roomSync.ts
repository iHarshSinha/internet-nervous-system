import { checkSeq, type Frame } from '@ins/shared';

export interface SyncStats {
  /** Frames handed on to be applied. */
  applied: number;
  /** Frames dropped because they had already been applied (or were in a snapshot). */
  duplicates: number;
  /** Times a sequence number was skipped. */
  gaps: number;
  /** Times the server re-sent missing frames. */
  resyncs: number;
  /** Times the missing frames were too old for the server's buffer. */
  tooOld: number;
}

export interface SyncResult {
  /** Frames to apply now, in order. */
  apply: Frame[];
  /** Ask the server for every frame after this sequence number. */
  resyncAfter?: number;
  /** Some frames are lost for good: reload this room from the history API. */
  stale?: boolean;
}

/**
 * Keeps one room's frames gap-free and in order, on the client.
 *
 *  - Before the server has acknowledged the subscription we do not know
 *    where the stream starts, so frames are held.
 *  - A frame whose number is not newer than the last applied is a duplicate.
 *  - A frame that skips a number means some were lost. It is held, and the
 *    caller is told to send `resync`. Frames that arrive meanwhile are held
 *    too, and everything is applied in order once the missing ones are back.
 *  - `snapshot(seq)` is the history half of the merge protocol: the history
 *    response already includes everything up to `seq`, so frames up to it are
 *    dropped and the stream continues from there.
 */
/** Frames held while waiting before we give up on a resync (about a minute of one room). */
const MAX_HELD = 200;

export class RoomSync {
  readonly stats: SyncStats = { applied: 0, duplicates: 0, gaps: 0, resyncs: 0, tooOld: 0 };

  private last: number | null = null;
  private waiting = false;
  private held: Frame[] = [];

  /** Sequence number of the last frame applied; null until the subscription is acknowledged. */
  get lastApplied(): number | null {
    return this.last;
  }

  /** The server acknowledged the subscription; the next frame will be `seq + 1`. */
  start(seq: number): SyncResult {
    this.last = seq;
    return this.drain();
  }

  receive(frame: Frame): SyncResult {
    this.held.push(frame);
    // A resync that never comes back must not make us hold frames forever.
    if (this.waiting && this.held.length > MAX_HELD) return this.resynced(null);
    if (this.last === null || this.waiting) return { apply: [] };
    return this.drain();
  }

  /** The server's answer to `resync`: the missing frames, or null if they are gone. */
  resynced(frames: Frame[] | null): SyncResult {
    this.waiting = false;
    if (frames === null) {
      this.stats.tooOld += 1;
      // Carry on from the oldest frame we do have; the caller reloads history
      // to fill what was lost.
      const oldest = Math.min(...this.held.map((f) => f.s));
      if (Number.isFinite(oldest)) this.last = oldest - 1;
      return { ...this.drain(), stale: true };
    }
    this.stats.resyncs += 1;
    this.held.push(...frames);
    return this.drain();
  }

  /** History has been loaded and includes every frame up to `seq`. */
  snapshot(seq: number): SyncResult {
    if (this.last === null || seq > this.last) this.last = seq;
    return this.drain();
  }

  /** Apply held frames in order for as long as there is no gap. */
  private drain(): SyncResult {
    if (this.last === null) return { apply: [] };
    this.held.sort((a, b) => a.s - b.s);

    const apply: Frame[] = [];
    while (this.held.length > 0) {
      const frame = this.held[0]!;
      const verdict = checkSeq(this.last, frame.s);
      if (verdict === 'gap') {
        this.stats.gaps += 1;
        this.waiting = true;
        return { apply, resyncAfter: this.last };
      }
      this.held.shift();
      if (verdict === 'duplicate') {
        this.stats.duplicates += 1;
        continue;
      }
      this.last = frame.s;
      this.stats.applied += 1;
      apply.push(frame);
    }
    return { apply };
  }
}
