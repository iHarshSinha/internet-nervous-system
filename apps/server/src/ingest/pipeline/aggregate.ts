import type { EventEnvelope } from '@ins/shared';

/** Running totals for one scope inside one open window. */
export interface Agg {
  /** Route announcements. */
  ann: number;
  /** Route withdrawals. */
  wd: number;
  /** Distinct prefixes withdrawn (a set, so one flapping prefix counts once). */
  pfx: Set<string>;
  /** Round-trip times of answered pings, in ms. */
  rtt: number[];
  /** Pings that got no answer at all. */
  lost: number;
  /** Distinct probes that reported a ping result (answered or not). */
  probes: Set<number>;
  /** Probes that connected / disconnected during the window. */
  joined: number;
  left: number;
}

export const newAgg = (): Agg => ({
  ann: 0,
  wd: 0,
  pfx: new Set(),
  rtt: [],
  lost: 0,
  probes: new Set(),
  joined: 0,
  left: 0,
});

/** What a window's totals become once it closes: plain numbers, ready to store or send. */
export interface Totals {
  ann: number;
  wd: number;
  pfx: number;
  /** Median and 95th-percentile round-trip time; null if no ping was answered. */
  p50: number | null;
  p95: number | null;
  /** Ping results in the window, answered or not. */
  pings: number;
  lost: number;
  /** Distinct probes that reported. */
  up: number;
  joined: number;
  left: number;
}

/** Add one event to an aggregate. */
export function applyEvent(agg: Agg, event: EventEnvelope): void {
  switch (event.kind) {
    case 'bgp.announce':
      agg.ann += 1;
      break;
    case 'bgp.withdraw':
      agg.wd += 1;
      if (event.entity.prefix) agg.pfx.add(event.entity.prefix);
      break;
    case 'atlas.ping': {
      const rtt = event.data.rtt;
      if (typeof rtt === 'number') agg.rtt.push(rtt);
      else agg.lost += 1;
      if (event.entity.probeId !== undefined) agg.probes.add(event.entity.probeId);
      break;
    }
    case 'atlas.probe_status':
      if (event.data.event === 'connect') agg.joined += 1;
      else agg.left += 1;
      break;
    default:
      break;
  }
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return Math.round(sorted[Math.max(0, rank - 1)]! * 10) / 10;
}

export function finalise(agg: Agg): Totals {
  const sorted = agg.rtt.slice().sort((a, b) => a - b);
  return {
    ann: agg.ann,
    wd: agg.wd,
    pfx: agg.pfx.size,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    pings: agg.rtt.length + agg.lost,
    lost: agg.lost,
    up: agg.probes.size,
    joined: agg.joined,
    left: agg.left,
  };
}
