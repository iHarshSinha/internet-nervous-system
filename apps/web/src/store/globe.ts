import { pointTime, type CountriesResponse, type Frame, type ProbesResponse } from '@ins/shared';
import { create } from 'zustand';

export interface CountryLive {
  /** Health 0..100 from the latest closed minute. */
  h?: number;
  /** Route changes in the last second (drives the pulses). */
  act?: number;
  /** Median latency of the country's probes, latest minute. */
  p50?: number | null;
  /** World-room sequence number of the frame that last changed this country. */
  seq: number;
}

/**
 * State of the globe. The maps are mutated in place (thousands of probes
 * change every few seconds) and `version` is bumped, so components that care
 * re-read the maps on their own schedule instead of re-rendering per delta.
 */
interface GlobeState {
  version: number;
  countries: Map<string, CountryLive>;
  /** Probe id -> [lat, lng, cc]. */
  probePos: Map<number, [number, number, string]>;
  /** Probe id -> latency bucket, and the frame that set it. */
  probeBucket: Map<number, number>;
  probeSeq: Map<number, number>;
  /** The world's last 120 one-second routing windows, oldest first (for the sparkline). */
  worldSeconds: { t: number; ann: number; wd: number }[];
}

export const useGlobe = create<GlobeState>(() => ({
  version: 0,
  countries: new Map(),
  probePos: new Map(),
  probeBucket: new Map(),
  probeSeq: new Map(),
  worldSeconds: [],
}));

const bump = () => useGlobe.setState((s) => ({ version: s.version + 1 }));

/** Fill the pulse chart from history at load, so it does not start empty. Merged by time. */
export function seedWorldSeconds(points: { t: number; ann: number; wd: number }[]): void {
  const { worldSeconds } = useGlobe.getState();
  const known = new Set(worldSeconds.map((p) => p.t));
  for (const p of points) if (!known.has(p.t)) worldSeconds.push({ t: p.t, ann: p.ann, wd: p.wd });
  worldSeconds.sort((a, b) => a.t - b.t);
  worldSeconds.splice(0, Math.max(0, worldSeconds.length - 120));
  bump();
}

/** Take the globe's share of a `world` frame: `cc:<CC>` and `p:<id>` deltas. */
export function applyWorldFrame(frame: Frame): void {
  const { countries, probeBucket, probeSeq, worldSeconds } = useGlobe.getState();
  let changed = false;
  for (const [key, field, value] of frame.d) {
    const at = pointTime(key);
    if (at?.res === 's' && field === 'bgp' && typeof value === 'object' && value !== null) {
      const v = value as { ann?: number; wd?: number };
      const point = { t: at.t, ann: v.ann ?? 0, wd: v.wd ?? 0 };
      // The same second again is a correction (late events from a slow collector): replace it.
      const i = worldSeconds.findIndex((p) => p.t === at.t);
      if (i >= 0) worldSeconds[i] = point;
      else {
        worldSeconds.push(point);
        worldSeconds.sort((a, b) => a.t - b.t);
        if (worldSeconds.length > 120) worldSeconds.shift();
      }
      changed = true;
    } else if (key.startsWith('cc:')) {
      const cc = key.slice(3);
      const c = countries.get(cc) ?? { seq: 0 };
      if (field === 'h' && typeof value === 'number') c.h = value;
      else if (field === 'act' && typeof value === 'number') c.act = value;
      else if (field === 'p50' && (typeof value === 'number' || value === null)) c.p50 = value;
      c.seq = frame.s;
      countries.set(cc, c);
      changed = true;
    } else if (key.startsWith('p:') && field === 'b' && typeof value === 'number') {
      const id = Number(key.slice(2));
      probeBucket.set(id, value);
      probeSeq.set(id, frame.s);
      changed = true;
    }
  }
  if (changed) bump();
}

/**
 * Load the probe snapshot. A row is used only if no live frame newer than the
 * snapshot has already set that probe: the merge rule of `snapshotSeq`.
 */
export function loadProbes(res: ProbesResponse): void {
  const { probePos, probeBucket, probeSeq } = useGlobe.getState();
  for (const [id, lat, lng, cc, bucket] of res.probes) {
    probePos.set(id, [lat, lng, cc]);
    if (bucket >= 0 && (probeSeq.get(id) ?? 0) <= res.snapshotSeq) probeBucket.set(id, bucket);
  }
  bump();
}

/** Load the country health snapshot, by the same rule. */
export function loadCountryHealth(res: CountriesResponse): void {
  const { countries } = useGlobe.getState();
  for (const [cc, snap] of Object.entries(res.countries)) {
    const c = countries.get(cc) ?? { seq: 0 };
    if (c.seq <= res.snapshotSeq) {
      c.h = snap.h;
      c.p50 = snap.p50;
    }
    countries.set(cc, c);
  }
  bump();
}
