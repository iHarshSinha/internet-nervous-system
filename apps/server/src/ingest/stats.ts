import type { Source } from '@ins/shared';

/** Running totals for one source. Rates are worked out by whoever reads them. */
export interface SourceCounters {
  /** Upstream messages received. */
  messages: number;
  /** Events produced (one RIS message can produce several). */
  events: number;
  /** Messages that failed schema validation or were not JSON. */
  rejected: number;
  /** Messages from the feed about itself (errors, drop warnings). */
  warnings: number;
  /** Sum and count of (receive time - event time), to compute a mean lag. */
  lagSumMs: number;
  lagCount: number;
}

const empty = (): SourceCounters => ({
  messages: 0,
  events: 0,
  rejected: 0,
  warnings: 0,
  lagSumMs: 0,
  lagCount: 0,
});

/** Counters for every live source, shared by the connectors and the metrics. */
export class IngestStats {
  private readonly bySource = new Map<Source, SourceCounters>();

  of(source: Source): SourceCounters {
    let counters = this.bySource.get(source);
    if (!counters) {
      counters = empty();
      this.bySource.set(source, counters);
    }
    return counters;
  }

  /** Record that a valid message produced `events` events stamped `tsMs`. */
  accepted(source: Source, events: number, tsMs: number, receivedAt: number): void {
    const c = this.of(source);
    c.messages += 1;
    c.events += events;
    // A timestamp ahead of our clock comes from a wrong clock upstream
    // (Phase 0 saw 727 in 30 minutes); it says nothing about lag.
    const lag = receivedAt - tsMs;
    if (lag >= 0) {
      c.lagSumMs += lag;
      c.lagCount += 1;
    }
  }

  rejected(source: Source): void {
    const c = this.of(source);
    c.messages += 1;
    c.rejected += 1;
  }

  warning(source: Source): void {
    this.of(source).warnings += 1;
  }

  sources(): Source[] {
    return [...this.bySource.keys()];
  }
}
