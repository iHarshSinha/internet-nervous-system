/**
 * Percentiles over a recent stretch of time, cheaply.
 *
 * Values go into the current bucket; buckets rotate every `bucketMs`, and
 * the last `buckets` of them are what a snapshot looks at (10 s by
 * default). Each bucket keeps at most `cap` values (reservoir sampling), so
 * memory stays fixed however many values arrive.
 */
export class RecentQuantiles {
  private readonly cap: number;
  private readonly keep: number;
  private ring: { values: number[]; seen: number }[] = [];
  private readonly random: () => number;

  constructor(
    opts: { bucketMs?: number; buckets?: number; cap?: number; random?: () => number } = {},
  ) {
    this.cap = opts.cap ?? 2000;
    this.keep = opts.buckets ?? 5;
    this.random = opts.random ?? Math.random;
    this.ring.push({ values: [], seen: 0 });
    const timer = setInterval(() => this.rotate(), opts.bucketMs ?? 2000);
    timer.unref();
  }

  add(value: number): void {
    const b = this.ring.at(-1)!;
    b.seen += 1;
    if (b.values.length < this.cap) b.values.push(value);
    else {
      const j = Math.floor(this.random() * b.seen);
      if (j < this.cap) b.values[j] = value;
    }
  }

  /** Start a new bucket (called by the timer; public for tests). */
  rotate(): void {
    this.ring.push({ values: [], seen: 0 });
    if (this.ring.length > this.keep) this.ring.shift();
  }

  snapshot(): { p50: number; p95: number; p99: number; max: number; n: number } {
    const all = this.ring.flatMap((b) => b.values).sort((a, b) => a - b);
    const n = this.ring.reduce((sum, b) => sum + b.seen, 0);
    if (all.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, n };
    const q = (p: number) => Math.round(all[Math.min(all.length - 1, Math.floor(p * all.length))]!);
    return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(all.at(-1)!), n };
  }
}
