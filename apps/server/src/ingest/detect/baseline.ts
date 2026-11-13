/**
 * "What is normal for this network?" A robust baseline over the last hour of
 * per-minute counts: the median, and the median absolute deviation (MAD).
 * Unlike a mean and standard deviation, one wild minute barely moves them,
 * so a storm cannot quietly raise its own bar.
 */
export class MinuteBaseline {
  private readonly values: number[] = [];
  private readonly size: number;

  constructor(size = 60) {
    this.size = size;
  }

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
  }

  get count(): number {
    return this.values.length;
  }

  /** True when every remembered minute was zero (the entry can be forgotten). */
  get idle(): boolean {
    return this.values.every((v) => v === 0);
  }

  median(): number {
    return median(this.values);
  }

  mad(): number {
    const m = this.median();
    return median(this.values.map((v) => Math.abs(v - m)));
  }

  /**
   * How unusual `value` is, in robust standard deviations. 1.4826 scales the
   * MAD to a standard deviation for normal data; +1 keeps a perfectly flat
   * history from turning any small blip into infinity.
   */
  z(value: number): number {
    return (value - this.median()) / (1.4826 * this.mad() + 1);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Counts per second over the last `span` seconds, in a ring. Adding and
 * summing are cheap, and old seconds fall off by themselves.
 */
export class SecondRing {
  private readonly counts: Float64Array;
  private readonly stamps: Float64Array;
  private readonly span: number;

  constructor(span = 120) {
    this.span = span;
    this.counts = new Float64Array(span);
    this.stamps = new Float64Array(span).fill(-1);
  }

  add(ts: number, n = 1): void {
    const second = Math.floor(ts / 1000);
    const i = second % this.span;
    if (this.stamps[i] !== second) {
      this.stamps[i] = second;
      this.counts[i] = 0;
    }
    this.counts[i]! += n;
  }

  /** Sum over the `seconds` before `now`. */
  sum(now: number, seconds: number): number {
    const current = Math.floor(now / 1000);
    let total = 0;
    for (let i = 0; i < this.span; i++) {
      const s = this.stamps[i]!;
      if (s > current - seconds && s <= current) total += this.counts[i]!;
    }
    return total;
  }
}
