export interface WatermarkOptions {
  /** How long to wait for stragglers before a window may close. */
  latenessMs: number;
  /**
   * A partition this far behind the leading one no longer holds everyone back;
   * its events may then arrive late. Without this, one slow connection would
   * delay every window.
   */
  maxSkewMs: number;
  /** A partition that has sent nothing for this long (wall clock) is ignored. */
  idleMs: number;
  /** Timestamps further ahead of our clock than this are refused. */
  futureToleranceMs?: number;
}

interface Partition {
  /** Newest event time seen from this partition. */
  maxTs: number;
  /** Wall-clock time we last heard from it. */
  seenAt: number;
}

/**
 * Decides how far event time has safely progressed.
 *
 * Events do not arrive in order, and they arrive over several connections
 * ("partitions": one per RIS collector) that run at different delays. Phase 0
 * measured one collector 40 seconds behind while another was 3 seconds behind.
 *
 * The watermark is a promise: "we do not expect events older than this any
 * more". It is the slowest healthy partition's newest timestamp, minus an
 * allowed lateness. Windows that end before the watermark can be closed.
 *
 *   - A partition that is idle, or too far behind the leader, is left out so
 *     it cannot stall the others.
 *   - A timestamp from the future (a probe with a wrong clock) is refused, so
 *     it cannot push the watermark forward and make honest events look late.
 *   - The watermark never moves backwards.
 */
export class Watermark {
  private readonly parts = new Map<string, Partition>();
  private readonly opts: Required<WatermarkOptions>;
  private value = 0;
  private newestTs = 0;

  constructor(opts: WatermarkOptions) {
    this.opts = { futureToleranceMs: 60_000, ...opts };
  }

  /** Record an event's timestamp. Returns false if it is from the future and must be dropped. */
  observe(partition: string, ts: number, now: number): boolean {
    if (ts > now + this.opts.futureToleranceMs) return false;
    const part = this.parts.get(partition);
    if (part) {
      if (ts > part.maxTs) part.maxTs = ts;
      part.seenAt = now;
    } else {
      this.parts.set(partition, { maxTs: ts, seenAt: now });
    }
    if (ts > this.newestTs) this.newestTs = ts;
    return true;
  }

  /** The current watermark, in event time. */
  current(now: number): number {
    let lead = 0;
    let anyActive = false;
    for (const part of this.parts.values()) {
      if (now - part.seenAt > this.opts.idleMs) continue;
      anyActive = true;
      if (part.maxTs > lead) lead = part.maxTs;
    }

    if (!anyActive) {
      // Every partition has gone quiet (feed down, or a replay finished).
      // Nothing more is coming, so release everything we have seen.
      if (this.newestTs > this.value) this.value = this.newestTs;
      return this.value;
    }

    let slowest = Infinity;
    for (const part of this.parts.values()) {
      if (now - part.seenAt > this.opts.idleMs) continue;
      if (lead - part.maxTs > this.opts.maxSkewMs) continue;
      if (part.maxTs < slowest) slowest = part.maxTs;
    }
    const candidate = slowest - this.opts.latenessMs;
    if (candidate > this.value) this.value = candidate;
    return this.value;
  }

  /**
   * Event time up to which EVERY partition still sending has delivered (less
   * the lateness), lagging ones included. `current` leaves a partition that
   * is far behind out so it cannot hold everyone back; this does not, so a
   * window before this mark has (nearly) all its events, late ones too.
   */
  complete(now: number): number {
    let slowest = Infinity;
    for (const part of this.parts.values()) {
      if (now - part.seenAt > this.opts.idleMs) continue;
      if (part.maxTs < slowest) slowest = part.maxTs;
    }
    if (slowest === Infinity) return this.newestTs;
    return slowest - this.opts.latenessMs;
  }

  /** How far each partition is behind the leader, in ms. For the status page. */
  skews(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, part] of this.parts) out[name] = this.newestTs - part.maxTs;
    return out;
  }
}
