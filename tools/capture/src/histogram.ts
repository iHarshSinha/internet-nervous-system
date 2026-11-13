/**
 * A small fixed-memory histogram for durations in milliseconds.
 *
 * Buckets grow by a constant ratio (about 10% each), so it covers 1 ms to
 * several hours in a few hundred counters and a percentile is accurate to
 * within one bucket (about 10%). We use it instead of keeping every sample,
 * so measuring does not itself use a growing amount of memory.
 */
export class LogHistogram {
  private static readonly RATIO = 1.1;
  private static readonly LOG_RATIO = Math.log(LogHistogram.RATIO);
  private readonly buckets = new Uint32Array(200); // 1.1^199 ms is about 49 hours
  private total = 0;
  private maxSeen = 0;

  add(ms: number): void {
    const v = ms < 1 ? 1 : ms;
    const i = Math.min(this.buckets.length - 1, Math.floor(Math.log(v) / LogHistogram.LOG_RATIO));
    this.buckets[i]! += 1;
    this.total += 1;
    if (ms > this.maxSeen) this.maxSeen = ms;
  }

  get count(): number {
    return this.total;
  }

  get max(): number {
    return this.maxSeen;
  }

  /** Value below which `p` (0..1) of the samples fall; null if empty. */
  percentile(p: number): number | null {
    if (this.total === 0) return null;
    const target = Math.ceil(p * this.total);
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      seen += this.buckets[i]!;
      if (seen >= target) {
        // Upper edge of the bucket, but never more than the largest sample.
        return Math.min(this.maxSeen, Math.round(LogHistogram.RATIO ** (i + 1)));
      }
    }
    return this.maxSeen;
  }
}
