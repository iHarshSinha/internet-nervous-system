import type { EventEnvelope } from '@ins/shared';
import { applyEvent, finalise, newAgg, type Agg, type Totals } from './aggregate.ts';
import { Deduper } from './dedupe.ts';
import { OriginTable } from './origins.ts';
import { Watermark } from './watermark.ts';
import { TumblingWindows, type ClosedWindow } from './windows.ts';

/** Which feed family a window belongs to. The two run on very different delays. */
export type Family = 'bgp' | 'atlas';

export interface WindowResult {
  family: Family;
  start: number;
  sizeMs: number;
  scopes: Map<string, Totals>;
}

export interface PipelineOptions {
  /** Called for every closed 1-second window (routing only). Feeds the live UI. */
  onSecond(window: WindowResult): void;
  /** Called for every closed 1-minute window. Feeds storage and detection. */
  onMinute(window: WindowResult): void;
}

export interface PipelineCounters {
  /** Events offered to the pipeline. */
  received: number;
  /** Dropped: the same event ID had been seen already. */
  duplicates: number;
  /** Dropped: timestamp ahead of our clock. */
  future: number;
  /** Arrived after their 1-second window had closed (still counted in the minute). */
  lateSecond: number;
  /** Arrived after their 1-minute window had closed. Not counted in any window. */
  lateMinute: number;
  /** Events counted in a 1-minute window. */
  counted: number;
}

const SECOND = 1000;
const MINUTE = 60_000;

/*
 * Lateness settings come from the Phase 0 measurements (docs/benchmarks.md):
 *  - Routing: out-of-order by 1.3 s at the median and 4.0 s at p99 inside a
 *    healthy connection; a slow collector can run 40+ s behind the others.
 *  - Atlas: results arrive 102 s behind at the median and 240 s at p99.
 */
const BGP_SECOND = { latenessMs: 5_000, maxSkewMs: 15_000, idleMs: 30_000 };
const BGP_MINUTE = { latenessMs: 5_000, maxSkewMs: 90_000, idleMs: 30_000 };
const ATLAS_MINUTE = { latenessMs: 240_000, maxSkewMs: 0, idleMs: 60_000 };

/**
 * The stream processor. Every event from every source passes through here:
 *
 *   dedupe -> resolve owner -> event-time windows (1 s and 1 min) -> totals
 *
 * It does no I/O. Closed windows are handed to callbacks, and the clock is
 * passed in, so a recorded stream produces exactly the same result every time.
 */
export class Pipeline {
  readonly counters: PipelineCounters = {
    received: 0,
    duplicates: 0,
    future: 0,
    lateSecond: 0,
    lateMinute: 0,
    counted: 0,
  };
  readonly origins = new OriginTable();

  private readonly dedupe = new Deduper();
  private readonly opts: PipelineOptions;

  private readonly bgpSecondMark = new Watermark(BGP_SECOND);
  private readonly bgpMinuteMark = new Watermark(BGP_MINUTE);
  private readonly atlasMinuteMark = new Watermark(ATLAS_MINUTE);
  private readonly bgpSeconds = new TumblingWindows<Agg>(SECOND, newAgg);
  private readonly bgpMinutes = new TumblingWindows<Agg>(MINUTE, newAgg);
  private readonly atlasMinutes = new TumblingWindows<Agg>(MINUTE, newAgg);

  constructor(opts: PipelineOptions) {
    this.opts = opts;
  }

  /**
   * Take the events of ONE upstream message. They share a message ID
   * (`ris:<id>#0`, `#1`, ...), so checking the first one covers them all.
   */
  ingest(batch: EventEnvelope[], now: number): void {
    const first = batch[0];
    if (!first) return;
    this.counters.received += batch.length;

    if (this.dedupe.isDuplicate(first.eid, now)) {
      this.counters.duplicates += batch.length;
      return;
    }

    for (const event of batch) {
      if (event.kind.startsWith('bgp.')) this.addBgp(event, now);
      else if (event.kind.startsWith('atlas.')) this.addAtlas(event, now);
    }
  }

  private addBgp(event: EventEnvelope, now: number): void {
    // One partition per collector: each has its own connection and its own delay.
    const partition = event.entity.collector ?? 'unknown';
    const fresh = this.bgpSecondMark.observe(partition, event.ts, now);
    this.bgpMinuteMark.observe(partition, event.ts, now);
    if (!fresh) {
      this.counters.future += 1;
      return;
    }

    // Work out which network this is about. Announcements say; withdrawals do
    // not, so we look up who announced the prefix before.
    const prefix = event.entity.prefix;
    let asn = event.entity.asn;
    if (prefix) {
      if (event.kind === 'bgp.announce' && asn !== undefined) this.origins.learn(prefix, asn);
      else if (event.kind === 'bgp.withdraw') asn = this.origins.originOf(prefix);
    }

    const second = this.bgpSeconds.slot('world', event.ts);
    if (second) applyEvent(second, event);
    else this.counters.lateSecond += 1;

    const minute = this.bgpMinutes.slot('world', event.ts);
    if (!minute) {
      this.counters.lateMinute += 1;
      return;
    }
    applyEvent(minute, event);
    this.counters.counted += 1;
    if (asn !== undefined) applyEvent(this.bgpMinutes.slot(`asn:${asn}`, event.ts)!, event);
  }

  private addAtlas(event: EventEnvelope, now: number): void {
    if (!this.atlasMinuteMark.observe('atlas', event.ts, now)) {
      this.counters.future += 1;
      return;
    }
    const minute = this.atlasMinutes.slot('world', event.ts);
    if (!minute) {
      this.counters.lateMinute += 1;
      return;
    }
    applyEvent(minute, event);
    this.counters.counted += 1;
  }

  /** Close every window the watermarks allow. Call a few times per second. */
  tick(now: number): void {
    this.emit('bgp', this.bgpSeconds.close(this.bgpSecondMark.current(now)), this.opts.onSecond);
    this.emit('bgp', this.bgpMinutes.close(this.bgpMinuteMark.current(now)), this.opts.onMinute);
    this.emit(
      'atlas',
      this.atlasMinutes.close(this.atlasMinuteMark.current(now)),
      this.opts.onMinute,
    );
  }

  /** End of stream (a replay finished, or shutdown): close every open window now. */
  flush(): void {
    const end = Number.MAX_SAFE_INTEGER;
    this.emit('bgp', this.bgpSeconds.close(end), this.opts.onSecond);
    this.emit('bgp', this.bgpMinutes.close(end), this.opts.onMinute);
    this.emit('atlas', this.atlasMinutes.close(end), this.opts.onMinute);
  }

  private emit(
    family: Family,
    windows: ClosedWindow<Agg>[],
    deliver: (window: WindowResult) => void,
  ): void {
    for (const window of windows) {
      const scopes = new Map<string, Totals>();
      for (const [scope, agg] of window.scopes) scopes.set(scope, finalise(agg));
      deliver({ family, start: window.start, sizeMs: window.sizeMs, scopes });
    }
  }

  /** For the status endpoint. */
  snapshot() {
    return {
      ...this.counters,
      dedupeEntries: this.dedupe.size,
      knownPrefixes: this.origins.size,
      openWindows: {
        bgpSeconds: this.bgpSeconds.openCount,
        bgpMinutes: this.bgpMinutes.openCount,
        atlasMinutes: this.atlasMinutes.openCount,
      },
      collectorSkewMs: this.bgpMinuteMark.skews(),
    };
  }
}
