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
  /**
   * A correction: this already-closed window received late events. `scopes`
   * holds only the scopes that changed, each with its full new totals.
   */
  amended?: boolean;
}

/**
 * Where things are. The pipeline only reads this; the reference data module
 * fills it. Answers are undefined until the data has loaded.
 */
export interface Lookup {
  /** Country a network is registered in. */
  asnCountry(asn: number): string | undefined;
  /** Country and network of an Atlas probe. */
  probe(id: number): { cc?: string; asn?: number } | undefined;
}

const noLookup: Lookup = { asnCountry: () => undefined, probe: () => undefined };

/** What the pipeline knows about one deduplicated event; handed to the detectors. */
export interface EventContext {
  /** Owning network: given by announcements, looked up for withdrawals, the probe's for Atlas. */
  asn: number | undefined;
  cc: string | undefined;
  /** For an announcement that changed a prefix's origin: the previous owner. */
  prevOrigin: number | undefined;
  /** Live traffic for a network that a running scenario is simulating; detectors ignore it. */
  masked: boolean;
}

export interface PipelineOptions {
  /** Every deduplicated, attributed event, for the detectors. */
  onEvent?(event: EventEnvelope, ctx: EventContext): void;
  /**
   * While a scenario simulates a network, live updates for it would quietly
   * undo the simulation (the real network is fine). This says which networks
   * to keep live updates away from, for reachability and detection.
   */
  isMasked?(asn: number): boolean;
  lookup?: Lookup;
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
  /** Arrived after their 1-second window had closed and were added to it as a correction. */
  amendedSecond: number;
  /** Arrived even after the correction horizon (2 min); still counted in the minute. */
  lateSecond: number;
  /** Arrived after their 1-minute window had closed. Not counted in any window. */
  lateMinute: number;
  /** Events counted in a 1-minute window. */
  counted: number;
}

const SECOND = 1000;
const MINUTE = 60_000;
/**
 * A closed 1-second window still takes late events for this long. Collectors
 * can fall far behind (Phase 0 saw 84 s before a disconnect); the window then
 * closes without them and is corrected as their events arrive.
 */
const SECOND_AMEND_MS = 120_000;

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
    amendedSecond: 0,
    lateSecond: 0,
    lateMinute: 0,
    counted: 0,
  };
  readonly origins = new OriginTable();
  /** Latest ping result per probe (by the probe's own timestamp). */
  readonly probeLatest = new Map<number, { ts: number; rtt: number | null }>();
  /** Probes whose latest result changed since the consumer last looked. */
  readonly probesChanged = new Set<number>();

  private readonly dedupe = new Deduper();
  private readonly opts: PipelineOptions;
  private readonly lookup: Lookup;

  private readonly bgpSecondMark = new Watermark(BGP_SECOND);
  private readonly bgpMinuteMark = new Watermark(BGP_MINUTE);
  private readonly atlasMinuteMark = new Watermark(ATLAS_MINUTE);
  private readonly bgpSeconds = new TumblingWindows<Agg>(SECOND, newAgg, SECOND_AMEND_MS);
  private readonly bgpMinutes = new TumblingWindows<Agg>(MINUTE, newAgg);
  private readonly atlasMinutes = new TumblingWindows<Agg>(MINUTE, newAgg);

  constructor(opts: PipelineOptions) {
    this.opts = opts;
    this.lookup = opts.lookup ?? noLookup;
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
    if (prefix && event.kind === 'bgp.withdraw') asn = this.origins.originOf(prefix);
    const masked =
      asn !== undefined && event.data.simulated !== true && (this.opts.isMasked?.(asn) ?? false);

    // Update who owns what and what is reachable (not for masked live traffic).
    let prevOrigin: number | undefined;
    if (prefix && !masked) {
      if (event.kind === 'bgp.announce' && asn !== undefined) {
        prevOrigin = this.origins.learn(prefix, asn);
      } else if (event.kind === 'bgp.withdraw') {
        this.origins.withdraw(prefix);
      }
    }

    const cc = asn === undefined ? undefined : this.lookup.asnCountry(asn);
    this.opts.onEvent?.(event, { asn, cc, prevOrigin, masked });

    // 1-second windows feed the live view: the world and each country.
    const second = this.bgpSeconds.slot('world', event.ts);
    if (second) {
      applyEvent(second, event);
      if (cc) applyEvent(this.bgpSeconds.slot(`country:${cc}`, event.ts)!, event);
    } else {
      // Its second has closed (a slow collector): correct that second instead of losing it.
      const closed = this.bgpSeconds.lateSlot('world', event.ts);
      if (closed) {
        applyEvent(closed, event);
        if (cc) applyEvent(this.bgpSeconds.lateSlot(`country:${cc}`, event.ts)!, event);
        this.counters.amendedSecond += 1;
      } else {
        this.counters.lateSecond += 1;
      }
    }

    // 1-minute windows feed storage and detection: world, country and network.
    const minute = this.bgpMinutes.slot('world', event.ts);
    if (!minute) {
      this.counters.lateMinute += 1;
      return;
    }
    applyEvent(minute, event);
    this.counters.counted += 1;
    if (asn !== undefined) applyEvent(this.bgpMinutes.slot(`asn:${asn}`, event.ts)!, event);
    if (cc) applyEvent(this.bgpMinutes.slot(`country:${cc}`, event.ts)!, event);
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
    this.trackProbe(event);

    // A probe's own country and network: where it physically is, which is
    // more meaningful for latency than where a network is registered.
    const probeId = event.entity.probeId;
    const probe = probeId === undefined ? undefined : this.lookup.probe(probeId);
    const asn = probe?.asn ?? event.entity.asn;
    this.opts.onEvent?.(event, {
      asn,
      cc: probe?.cc,
      prevOrigin: undefined,
      masked: false,
    });
    if (probe?.cc) applyEvent(this.atlasMinutes.slot(`country:${probe.cc}`, event.ts)!, event);
    if (asn !== undefined) applyEvent(this.atlasMinutes.slot(`asn:${asn}`, event.ts)!, event);
  }

  /** Remember each probe's most recent ping result (older results do not overwrite newer). */
  private trackProbe(event: EventEnvelope): void {
    const id = event.entity.probeId;
    if (event.kind !== 'atlas.ping' || id === undefined) return;
    const rtt = typeof event.data.rtt === 'number' ? event.data.rtt : null;
    const prev = this.probeLatest.get(id);
    if (prev && prev.ts >= event.ts) return;
    this.probeLatest.set(id, { ts: event.ts, rtt });
    this.probesChanged.add(id);
  }

  /** Close every window the watermarks allow. Call a few times per second. */
  tick(now: number): void {
    this.emit('bgp', this.bgpSeconds.close(this.bgpSecondMark.current(now)), this.opts.onSecond);
    this.emit('bgp', this.bgpSeconds.takeAmended(), this.opts.onSecond, true);
    // Never backwards: a collector reconnecting with older data must not rewind "now".
    this.secondsComplete = Math.max(this.secondsComplete, this.bgpSecondMark.complete(now));
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
    amended = false,
  ): void {
    for (const window of windows) {
      const scopes = new Map<string, Totals>();
      for (const [scope, agg] of window.scopes) scopes.set(scope, finalise(agg));
      deliver({
        family,
        start: window.start,
        sizeMs: window.sizeMs,
        scopes,
        ...(amended && { amended }),
      });
    }
  }

  /**
   * Event time up to which every connected collector has delivered (see
   * Watermark.complete). A 1-second window ending before it is complete,
   * corrections included: the one to show as "now".
   */
  secondsComplete = 0;

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
      secondsComplete: this.secondsComplete,
    };
  }
}
