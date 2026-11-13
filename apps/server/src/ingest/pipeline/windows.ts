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
 * A window stays open until the watermark passes its end; then it is emitted
 * once and never changes again. An event for an already-closed window is
 * "late": it is counted, not applied.
 */
export class TumblingWindows<A> {
  /** Events that arrived after their window had closed. */
  late = 0;

  private readonly open = new Map<number, Map<string, A>>();
  private closedUpTo = 0;
  private readonly sizeMs: number;
  private readonly create: () => A;

  constructor(sizeMs: number, create: () => A) {
    this.sizeMs = sizeMs;
    this.create = create;
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
      }
    }
    return done.sort((a, b) => a.start - b.start);
  }

  get openCount(): number {
    return this.open.size;
  }
}
