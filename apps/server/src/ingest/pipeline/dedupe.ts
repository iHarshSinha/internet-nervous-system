import { createHash } from 'node:crypto';

/**
 * Remembers which event IDs were seen recently, to drop duplicates.
 *
 * Duplicates come from reconnects (a feed re-sending its backlog) and from
 * restarting a replay. Keeping every ID string for ten minutes would cost
 * hundreds of megabytes at our measured rates, so we keep a 48-bit hash of
 * each ID instead, in two "generations":
 *
 *   - new IDs go into the current generation;
 *   - every `rotateMs` the current generation becomes the previous one and the
 *     old previous one is thrown away.
 *
 * An ID is therefore remembered for between one and two rotation periods
 * (5 to 10 minutes by default) with no per-entry timers.
 *
 * Two different IDs can share a hash, in which case the second is wrongly
 * dropped. With 48 bits and about a million remembered IDs that is roughly
 * one event in 280 million. MongoDB's unique `_id` is the exact backstop.
 */
export class Deduper {
  private current = new Set<number>();
  private previous = new Set<number>();
  private rotatedAt: number | null = null;
  private readonly rotateMs: number;

  constructor(rotateMs = 5 * 60_000) {
    this.rotateMs = rotateMs;
  }

  /** Returns true if `id` was seen before; otherwise remembers it and returns false. */
  isDuplicate(id: string, now: number): boolean {
    this.rotatedAt ??= now;
    if (now - this.rotatedAt >= this.rotateMs) {
      this.previous = this.current;
      this.current = new Set();
      this.rotatedAt = now;
    }

    const hash = createHash('md5').update(id).digest().readUIntBE(0, 6);
    if (this.current.has(hash) || this.previous.has(hash)) return true;
    this.current.add(hash);
    return false;
  }

  get size(): number {
    return this.current.size + this.previous.size;
  }
}
