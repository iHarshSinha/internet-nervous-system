export interface ClosedWindow<A> {
  /** Start of the window in event time (ms). It covers [start, start + sizeMs). */
  start: number;
  sizeMs: number;
  /** One aggregate per scope ("world", "asn:32934", ...). */
  scopes: Map<string, A>;
}

/**
 * Fixed-size, non-overlapping windows over EVENT time (when things happened),
 * not arrival time. An event stamped 12:00:07.3 always lands in the window
 * [12:00:07, 12:00:08), however late it arrives, as long as that window is
 * still open. That is what makes counts reproducible on replay.
 *
 * A window stays open until the watermark passes its end; then it is emitted.
 * An event for an already-closed window is "late". With `amendMs` set, closed
 * windows are kept that long and a late event still updates its window
 * (`lateSlot`); the changed windows are handed out again by `takeAmended`, so
 * results are first fast, then corrected. Without it, late events are only
 * counted.
 */
export class TumblingWindows<A> {
  /** Events that arrived after their window had closed. */
  late = 0;

  private readonly open = new Map<number, Map<string, A>>();
  private closedUpTo = 0;
  private readonly sizeMs: number;
  private readonly create: () => A;
  private readonly amendMs: number;
  /** Closed windows still accepting late events (start -> scopes). */
  private readonly kept = new Map<number, Map<string, A>>();
  /** Closed windows changed by late events since the last `takeAmended`: start -> scopes. */
  private readonly dirty = new Map<number, Set<string>>();

  constructor(sizeMs: number, create: () => A, amendMs = 0) {
    this.sizeMs = sizeMs;
    this.create = create;
    this.amendMs = amendMs;
  }

  /**
   * For a late event: the aggregate in its already-closed window, if that
   * window is still within the amendment horizon (null if not).
   */
  lateSlot(scope: string, ts: number): A | null {
    const start = ts - (ts % this.sizeMs);
    if (this.amendMs === 0 || start >= this.closedUpTo || start < this.closedUpTo - this.amendMs) {
      return null;
    }
    let scopes = this.kept.get(start);
    if (!scopes) {
      // A window that closed empty (nothing had arrived for it yet).
      scopes = new Map();
      this.kept.set(start, scopes);
    }
    let agg = scopes.get(scope);
    if (!agg) {
      agg = this.create();
      scopes.set(scope, agg);
    }
    let changed = this.dirty.get(start);
    if (!changed) {
      changed = new Set();
      this.dirty.set(start, changed);
    }
    changed.add(scope);
    return agg;
  }

  /** Closed windows that late events changed, with only the scopes that changed (full totals). */
  takeAmended(): ClosedWindow<A>[] {
    const out: ClosedWindow<A>[] = [];
    for (const [start, changed] of this.dirty) {
      const scopes = this.kept.get(start);
      if (!scopes) continue;
      const only = new Map<string, A>();
      for (const scope of changed) {
        const agg = scopes.get(scope);
        if (agg) only.set(scope, agg);
      }
      out.push({ start, sizeMs: this.sizeMs, scopes: only });
    }
    this.dirty.clear();
    return out.sort((a, b) => a.start - b.start);
  }

  /**
   * Get the aggregate for `scope` in the window containing `ts`, creating it
   * if needed. Returns null if that window has already closed.
   */
  slot(scope: string, ts: number): A | null {
    const start = ts - (ts % this.sizeMs);
    if (start < this.closedUpTo) return null;

    let scopes = this.open.get(start);
    if (!scopes) {
      scopes = new Map();
      this.open.set(start, scopes);
    }
    let agg = scopes.get(scope);
    if (!agg) {
      agg = this.create();
      scopes.set(scope, agg);
    }
    return agg;
  }

  /** Close and return every window that ends at or before the watermark, oldest first. */
  close(watermark: number): ClosedWindow<A>[] {
    const boundary = watermark - (watermark % this.sizeMs); // windows starting before this are complete
    if (boundary <= this.closedUpTo) return [];
    this.closedUpTo = boundary;

    const done: ClosedWindow<A>[] = [];
    for (const [start, scopes] of this.open) {
      if (start < boundary) {
        done.push({ start, sizeMs: this.sizeMs, scopes });
        this.open.delete(start);
        if (this.amendMs > 0) this.kept.set(start, scopes);
      }
    }
    // Forget windows past the amendment horizon.
    for (const start of this.kept.keys()) {
      if (start < boundary - this.amendMs) {
        this.kept.delete(start);
        this.dirty.delete(start);
      }
    }
    return done.sort((a, b) => a.start - b.start);
  }

  get openCount(): number {
    return this.open.size;
  }
}
