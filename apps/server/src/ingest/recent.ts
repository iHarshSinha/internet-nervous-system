import { healthScore, type MetricPoint } from '@ins/shared';
import type { WindowResult } from './pipeline/pipeline.ts';

/**
 * The last 15 minutes of 1-second routing points, per room (`world` and each
 * `country:<CC>`), kept in memory.
 *
 * MongoDB holds history at 1-minute resolution. A chart that hands over from
 * history to live data needs finer points for the recent past, and these are
 * them. Scope names are exactly the room names, so `get("country:IN")` gives
 * the points that the `country:IN` room's live frames continue.
 */
export class RecentSeconds {
  private readonly rings = new Map<string, MetricPoint[]>();
  private readonly max: number;

  constructor(max = 900) {
    this.max = max;
  }

  add(window: WindowResult): void {
    for (const [scope, t] of window.scopes) {
      if (scope !== 'world' && !scope.startsWith('country:')) continue;
      let ring = this.rings.get(scope);
      if (!ring) {
        ring = [];
        this.rings.set(scope, ring);
      }
      const point: MetricPoint = {
        t: window.start,
        ann: t.ann,
        wd: t.wd,
        pfx: t.pfx,
        p50: null,
        p95: null,
        up: 0,
        down: 0,
        health: healthScore({ ann: t.ann, wd: t.wd, pings: 0, lost: 0 }),
        late: 0,
      };
      // Usually the newest point. A correction (late events for a second that
      // already closed) replaces its point, or slots in if that second was empty.
      let i = ring.length - 1;
      while (i >= 0 && ring[i]!.t > point.t) i -= 1;
      if (i >= 0 && ring[i]!.t === point.t) ring[i] = point;
      else ring.splice(i + 1, 0, point);
      // Trim in chunks rather than shifting one element every second.
      if (ring.length > this.max + 60) ring.splice(0, ring.length - this.max);
    }
  }

  /** Points of `scope` from `from` (ms) onwards, oldest first. */
  get(scope: string, from: number): MetricPoint[] {
    const ring = this.rings.get(scope) ?? [];
    const start = ring.length > this.max ? ring.length - this.max : 0;
    const out: MetricPoint[] = [];
    for (let i = start; i < ring.length; i++) if (ring[i]!.t >= from) out.push(ring[i]!);
    return out;
  }

  get scopes(): number {
    return this.rings.size;
  }
}
