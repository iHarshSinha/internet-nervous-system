import { checkSeq, type Frame } from '@ins/shared';

/**
 * Percentiles of many values with fixed memory: up to `cap` values are kept
 * (reservoir sampling, so every value has the same chance of being kept),
 * while count, minimum, maximum and mean cover every value.
 */
export class Distribution {
  private readonly cap: number;
  private readonly kept: number[] = [];
  private readonly random: () => number;
  count = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;

  constructor(cap = 200_000, random: () => number = Math.random) {
    this.cap = cap;
    this.random = random;
  }

  add(v: number): void {
    this.count += 1;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    if (this.kept.length < this.cap) this.kept.push(v);
    else {
      const j = Math.floor(this.random() * this.count);
      if (j < this.cap) this.kept[j] = v;
    }
  }

  summary(): { n: number; mean: number; p50: number; p95: number; p99: number; max: number } {
    if (this.count === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = [...this.kept].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    const r = (v: number) => Math.round(v * 10) / 10;
    return {
      n: this.count,
      mean: r(this.sum / this.count),
      p50: r(q(0.5)),
      p95: r(q(0.95)),
      p99: r(q(0.99)),
      max: r(this.max),
    };
  }
}

/**
 * What one client checks about the frames it receives, per room: each frame
 * must continue the room's sequence exactly (a summary frame for a slow
 * client covers `f`..`s`). Anything else is a duplicate or a gap.
 */
export class SeqChecker {
  private readonly last = new Map<string, number>();
  gaps = 0;
  duplicates = 0;
  frames = 0;

  /** The `sub` acknowledgement: where each room's stream starts. */
  start(seqs: Record<string, number>): void {
    for (const [room, seq] of Object.entries(seqs)) this.last.set(room, seq);
  }

  check(frame: Frame): void {
    const last = this.last.get(frame.r);
    if (last === undefined) return; // a room we did not join (the "send to all" baseline)
    this.frames += 1;
    const verdict = checkSeq(last, frame.s, frame.f);
    if (verdict === 'duplicate') this.duplicates += 1;
    else {
      if (verdict === 'gap') this.gaps += 1;
      this.last.set(frame.r, frame.s);
    }
  }
}
