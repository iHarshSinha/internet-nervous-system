import type { EventEnvelope, EventKind } from '@ins/shared';

/**
 * How full the queue is, and what that means for incoming events:
 *
 *  - normal    below 70%: everything is accepted.
 *  - sampling  70-95%: everything is accepted; the raw feed shown to people
 *              thins to 1 event in k (k grows while the pressure lasts).
 *  - shedding  95-100%: route announcements are dropped (counted). They are
 *              the bulk of the stream and the least important single events.
 *  - reserve   100-120%: only withdrawals and probe connect/disconnect events
 *              get in. They are what outage detection needs, so they may use
 *              a reserve above the normal capacity.
 *  - full      120% and over: nothing gets in (counted as overflow).
 *
 * Counts (window totals) are made from the events that get through, after
 * dedupe and before any sampling; every dropped event is counted by kind.
 */
export type Pressure = 'normal' | 'sampling' | 'shedding' | 'reserve' | 'full';

const SAMPLE_AT = 0.7;
const SHED_AT = 0.95;
const RESERVE_UP_TO = 1.2;
/** Never dropped while there is reserve room. */
const PROTECTED = new Set<EventKind>(['bgp.withdraw', 'atlas.probe_status']);

export interface QueueOptions {
  /** Normal capacity in events (the reserve goes 20% above it). */
  capacity: number;
  /** Processes one upstream message's events (the pipeline). */
  process(batch: EventEnvelope[]): void;
  /** Work at most this long before letting the thread read sockets and run timers. */
  sliceMs?: number;
}

export interface QueueSnapshot {
  depth: number;
  capacity: number;
  /** depth / capacity (can pass 1 while the reserve is in use). */
  fill: number;
  pressure: Pressure;
  /** The raw feed keeps 1 event in this many (1 = all). */
  sampleEvery: number;
  /** Age of the oldest waiting message, ms. */
  oldestMs: number;
  /** Longest wait of any message in the last second, ms. */
  waitMaxMs: number;
  offered: number;
  processed: number;
  /** Events dropped by priority, per kind. */
  shed: Partial<Record<EventKind, number>>;
  shedTotal: number;
  /** Events refused at the hard limit (should stay 0). */
  overflow: number;
  /** Times a file source (replay) was paused because the queue was filling. */
  pauses: number;
  /** Highest depth seen. */
  maxDepth: number;
}

interface Item {
  batch: EventEnvelope[];
  at: number;
}

/**
 * The bounded queue between the upstream connectors and the pipeline, in
 * the ingest thread.
 *
 * Connectors only parse, validate and normalise, then offer the result here
 * and return, so the thread keeps reading its sockets. The pipeline drains
 * the queue in slices of a few milliseconds. When events arrive faster than
 * the pipeline handles them the queue grows, and the pressure levels above
 * decide what still gets in.
 *
 * Live feeds cannot be paused (RIS Live has no replay), so they shed. A file
 * source can be paused: `offerAndWait` returns a promise that resolves once
 * the queue is below half full again. That is real backpressure, with no loss.
 */
export class IngestQueue {
  private readonly opts: QueueOptions;
  private readonly sliceMs: number;
  private items: Item[] = [];
  private head = 0;
  private events = 0;
  private scheduled = false;
  private stopped = false;
  private waiters: (() => void)[] = [];
  private k = 1;
  private sampleCount = 0;
  private waitMax = 0;
  private waitMaxPrev = 0;
  private readonly timer: NodeJS.Timeout;
  private readonly counters = {
    offered: 0,
    processed: 0,
    shedTotal: 0,
    overflow: 0,
    pauses: 0,
    maxDepth: 0,
  };
  private readonly shed: Partial<Record<EventKind, number>> = {};

  constructor(opts: QueueOptions) {
    this.opts = opts;
    this.sliceMs = opts.sliceMs ?? 8;
    // Once a second: adapt the sampling ratio and roll the wait maximum.
    this.timer = setInterval(() => this.adapt(), 1000);
    this.timer.unref();
  }

  get depth(): number {
    return this.events;
  }

  pressure(): Pressure {
    const fill = this.events / this.opts.capacity;
    if (fill >= RESERVE_UP_TO) return 'full';
    if (fill >= 1) return 'reserve';
    if (fill >= SHED_AT) return 'shedding';
    if (fill >= SAMPLE_AT) return 'sampling';
    return 'normal';
  }

  /** From a live feed: accepted, thinned or dropped by the pressure level. */
  offer(batch: EventEnvelope[]): void {
    if (this.stopped || batch.length === 0) return;
    this.counters.offered += batch.length;
    const pressure = this.pressure();
    let keep = batch;
    if (pressure === 'full') {
      keep = [];
    } else if (pressure === 'reserve') {
      keep = batch.filter((e) => PROTECTED.has(e.kind));
    } else if (pressure === 'shedding') {
      keep = batch.filter((e) => e.kind !== 'bgp.announce');
    }
    if (keep.length < batch.length) {
      const kept = new Set(keep);
      for (const e of batch) {
        if (kept.has(e)) continue;
        if (pressure === 'full') this.counters.overflow += 1;
        else {
          this.shed[e.kind] = (this.shed[e.kind] ?? 0) + 1;
          this.counters.shedTotal += 1;
        }
      }
    }
    if (keep.length > 0) this.push(keep);
  }

  /**
   * From a file source: always accepted. Returns a promise when the queue
   * is past the sampling mark; the caller waits on it before reading more.
   */
  offerAndWait(batch: EventEnvelope[]): Promise<void> | undefined {
    if (this.stopped || batch.length === 0) return undefined;
    this.counters.offered += batch.length;
    this.push(batch);
    if (this.events < this.opts.capacity * SAMPLE_AT) return undefined;
    this.counters.pauses += 1;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * For the raw feed shown to people: true for 1 event in k. While the queue
   * is under pressure k grows, so the feed thins but the counts stay exact.
   */
  sample(): boolean {
    this.sampleCount = (this.sampleCount + 1) % this.k;
    return this.sampleCount === 0;
  }

  snapshot(): QueueSnapshot {
    const oldest = this.items[this.head];
    return {
      depth: this.events,
      capacity: this.opts.capacity,
      fill: Math.round((this.events / this.opts.capacity) * 1000) / 1000,
      pressure: this.pressure(),
      sampleEvery: this.k,
      oldestMs: oldest ? Math.round(performance.now() - oldest.at) : 0,
      waitMaxMs: Math.round(Math.max(this.waitMax, this.waitMaxPrev)),
      offered: this.counters.offered,
      processed: this.counters.processed,
      shed: { ...this.shed },
      shedTotal: this.counters.shedTotal,
      overflow: this.counters.overflow,
      pauses: this.counters.pauses,
      maxDepth: this.counters.maxDepth,
    };
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.items = [];
    this.head = 0;
    this.events = 0;
    this.release();
  }

  private push(batch: EventEnvelope[]): void {
    this.items.push({ batch, at: performance.now() });
    this.events += batch.length;
    if (this.events > this.counters.maxDepth) this.counters.maxDepth = this.events;
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    // setImmediate runs after pending I/O, so socket reads interleave with draining.
    setImmediate(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    const until = performance.now() + this.sliceMs;
    while (this.head < this.items.length) {
      const item = this.items[this.head]!;
      this.items[this.head] = undefined as unknown as Item; // let it be collected
      this.head += 1;
      this.events -= item.batch.length;
      const now = performance.now();
      if (now - item.at > this.waitMax) this.waitMax = now - item.at;
      this.opts.process(item.batch);
      this.counters.processed += item.batch.length;
      if (performance.now() >= until) break;
    }
    // Drop the consumed front of the array now and then, instead of shifting on every item.
    if (this.head > 4096 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    if (this.events < this.opts.capacity * 0.5) this.release();
    if (this.head < this.items.length) this.schedule();
  }

  private release(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  private adapt(): void {
    const fill = this.events / this.opts.capacity;
    // Double while under pressure, halve once it has eased (the gap avoids flapping).
    if (fill >= SAMPLE_AT) this.k = Math.min(1024, this.k * 2);
    else if (fill < 0.5 && this.k > 1) this.k = Math.max(1, this.k / 2);
    this.waitMaxPrev = this.waitMax;
    this.waitMax = 0;
  }
}
