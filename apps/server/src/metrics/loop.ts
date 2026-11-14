import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/** How often the event loop is sampled. */
const RESOLUTION_MS = 10;

/**
 * Event-loop delay: how late a timer fires compared with when it was due.
 *
 * Node's histogram measures the time between its own sampling timer's runs,
 * so it reports the sampling interval itself plus any delay (an idle loop
 * reads about 10 ms at a 10 ms resolution). The interval is subtracted here,
 * leaving only the delay.
 */
export class LoopDelay {
  private readonly h: IntervalHistogram;

  constructor() {
    this.h = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.h.enable();
  }

  /** Delay at percentile `p` (0-100) since the last reset, in ms, to 0.01 ms. */
  percentile(p: number): number {
    if (this.h.count === 0) return 0;
    const ms = this.h.percentile(p) / 1e6 - RESOLUTION_MS;
    return Math.max(0, Math.round(ms * 100) / 100);
  }

  reset(): void {
    this.h.reset();
  }

  stop(): void {
    this.h.disable();
  }
}
