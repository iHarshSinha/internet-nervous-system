import {
  countryKey,
  healthScore,
  latencyBucket,
  minuteKey,
  probeKey,
  rooms,
  secondKey,
  type BgpPoint,
  type CountriesResponse,
  type LatencyPoint,
} from '@ins/shared';
import type { IngestLink } from '../ingest/link.ts';
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

/** Latest closed minute per country, routing and latency kept separately. */
interface CountryState {
  ann: number;
  wd: number;
  pings: number;
  lost: number;
  p50: number | null;
  probes: number;
}

export interface Publisher {
  /** Current health of every country seen, for GET /api/countries. */
  countries(): CountriesResponse['countries'];
  stop(): void;
}

/**
 * Connect the pipeline to the rooms. Scope names are room names ("world",
 * "country:IN", "asn:13335"), so no translation is needed, and the
 * broadcaster ignores rooms nobody is in, so publishing everything is cheap.
 *
 *  - Every closed 1-second and 1-minute window goes to its own room.
 *  - Once a second the world room gets each country's health and each
 *    probe's latency bucket. The broadcaster sends only values that changed,
 *    plus everything again right after someone joins.
 */
export function startPublishing(ingest: IngestLink, broadcaster: Broadcaster): Publisher {
  const state = new Map<string, CountryState>();
  const countryOf = (scope: string) =>
    scope.startsWith('country:') ? scope.slice('country:'.length) : null;
  const stateOf = (cc: string) => {
    let s = state.get(cc);
    if (!s) {
      s = { ann: 0, wd: 0, pings: 0, lost: 0, p50: null, probes: 0 };
      state.set(cc, s);
    }
    return s;
  };
  const healthOf = (s: CountryState) => healthScore(s);

  ingest.onSecond((window) => {
    for (const [scope, totals] of window.scopes) {
      // Sent again, same key, when late events correct it: clients keep points by time.
      broadcaster.append(scope, secondKey(window.start), 'bgp', { ...bgp(totals) });
      // "Now" values come from fresh seconds only, never from a correction of an older one.
      if (window.amended) continue;
      // Health from one second only judges routing (latency is per minute).
      const health = healthScore({ ann: totals.ann, wd: totals.wd, pings: 0, lost: 0 });
      broadcaster.set(scope, 'now', 'health', health, 1);
      // Activity per country drives the pulses on the globe.
      const cc = countryOf(scope);
      if (cc) broadcaster.set(rooms.world, countryKey(cc), 'act', totals.ann + totals.wd);
    }
  });

  ingest.onMinute((window) => {
    const field = window.family === 'bgp' ? 'bgp' : 'lat';
    for (const [scope, totals] of window.scopes) {
      const value = window.family === 'bgp' ? bgp(totals) : latency(totals);
      broadcaster.append(scope, minuteKey(window.start), field, { ...value });

      const cc = countryOf(scope);
      if (!cc) continue;
      const s = stateOf(cc);
      if (window.family === 'bgp') {
        s.ann = totals.ann;
        s.wd = totals.wd;
      } else {
        s.pings = totals.pings;
        s.lost = totals.lost;
        s.p50 = totals.p50;
        s.probes = totals.up;
      }
    }
  });

  const timer = setInterval(() => {
    for (const [cc, s] of state) {
      broadcaster.set(rooms.world, countryKey(cc), 'h', healthOf(s), 1);
      broadcaster.set(rooms.world, countryKey(cc), 'p50', s.p50, 1);
    }
    const { probeLatest, probesChanged } = ingest;
    for (const id of probesChanged) {
      const latest = probeLatest.get(id);
      if (latest) broadcaster.set(rooms.world, probeKey(id), 'b', latencyBucket(latest.rtt));
    }
    probesChanged.clear();
  }, 1000);

  return {
    countries: () =>
      Object.fromEntries(
        [...state].map(([cc, s]) => [cc, { h: healthOf(s), p50: s.p50, probes: s.probes }]),
      ),
    stop: () => clearInterval(timer),
  };
}
