import {
  countryKey,
  healthScore,
  minuteKey,
  rooms,
  secondKey,
  type BgpPoint,
  type LatencyPoint,
} from '@ins/shared';
import type { Ingest } from '../ingest/index.ts';
import type { Totals } from '../ingest/pipeline/aggregate.ts';
import type { Broadcaster } from './broadcaster.ts';

const bgp = (t: Totals): BgpPoint => ({ ann: t.ann, wd: t.wd, pfx: t.pfx });
const latency = (t: Totals): LatencyPoint => ({
  p50: t.p50,
  p95: t.p95,
  pings: t.pings,
  lost: t.lost,
  up: t.up,
  down: t.left,
});

/**
 * Connect the pipeline to the rooms: every closed window becomes deltas in
 * the rooms that show it. Scope names are room names ("world",
 * "country:IN", "asn:13335"), so no translation is needed.
 *
 * The broadcaster ignores rooms nobody is in, so publishing to all ~100
 * active countries and ~800 networks costs almost nothing.
 */
export function publishWindows(ingest: Ingest, broadcaster: Broadcaster): void {
  ingest.onSecond((window) => {
    for (const [scope, totals] of window.scopes) {
      const point = bgp(totals);
      broadcaster.append(scope, secondKey(window.start), 'bgp', { ...point });

      // Health from a single second only judges routing (latency is per minute).
      const health = healthScore({ ann: totals.ann, wd: totals.wd, pings: 0, lost: 0 });
      broadcaster.set(scope, 'now', 'health', health, 1);

      // The world room also gets every country's health and activity, which
      // is what the globe colours and pulses with.
      if (scope.startsWith('country:')) {
        const key = countryKey(scope.slice('country:'.length));
        broadcaster.set(rooms.world, key, 'h', health, 1);
        broadcaster.set(rooms.world, key, 'act', totals.ann + totals.wd);
      }
    }
  });

  ingest.onMinute((window) => {
    const field = window.family === 'bgp' ? 'bgp' : 'lat';
    for (const [scope, totals] of window.scopes) {
      const value = window.family === 'bgp' ? bgp(totals) : latency(totals);
      broadcaster.append(scope, minuteKey(window.start), field, { ...value });
    }
  });
}
