/*
 * What the deltas inside live frames mean. A delta is `[key, field, value]`.
 *
 * In a `world`, `country:<CC>` or `asn:<N>` room:
 *
 *   ["s:<ms>", "bgp", {ann, wd, pfx}]
 *       One closed 1-second routing window starting at <ms>. Same values as a
 *       `seconds` point from GET /api/history for that time.
 *
 *   ["m:<ms>", "bgp", {ann, wd, pfx}]
 *   ["m:<ms>", "lat", {p50, p95, pings, lost, up, down}]
 *       One closed 1-minute window. Routing and latency minutes close at
 *       different times (latency waits about 4 minutes for late results), so
 *       they arrive separately; merge them by time, as history does.
 *
 *   ["now", "health", 0..100]
 *       The scope's current health, sent when it changes by at least 1 point.
 *
 * Only in the `world` room:
 *
 *   ["cc:<CC>", "h", 0..100]   a country's health (for colouring the globe)
 *   ["cc:<CC>", "act", n]      route changes in that country in the last second
 *   ["sys" | "src:<source>" | "world" | "pipe", <field>, number]   status values
 *
 * Points are keyed by their window's start time, so receiving the same point
 * twice (from history and from a frame) overwrites it with identical values:
 * it can never create a duplicate.
 */

export const secondKey = (ms: number) => `s:${ms}`;
export const minuteKey = (ms: number) => `m:${ms}`;
export const countryKey = (cc: string) => `cc:${cc}`;

/** Read the time out of a point key ("s:..." or "m:..."), or null for other keys. */
export function pointTime(key: string): { res: 's' | 'm'; t: number } | null {
  const res = key[0];
  if ((res !== 's' && res !== 'm') || key[1] !== ':') return null;
  const t = Number(key.slice(2));
  return Number.isInteger(t) ? { res, t } : null;
}

export interface BgpPoint {
  ann: number;
  wd: number;
  pfx: number;
}

export interface LatencyPoint {
  p50: number | null;
  p95: number | null;
  pings: number;
  lost: number;
  up: number;
  down: number;
}

/**
 * Latency colour buckets for probe dots on the globe. Only the bucket travels
 * over the socket, so a probe whose latency wobbles inside a bucket costs no
 * bandwidth. Upper bounds in ms; 5 means the last ping got no reply at all.
 */
export const LATENCY_BUCKETS_MS = [20, 50, 100, 200] as const;
export const LOST_BUCKET = 5;

export function latencyBucket(rttMs: number | null): number {
  if (rttMs === null) return LOST_BUCKET;
  const i = LATENCY_BUCKETS_MS.findIndex((limit) => rttMs < limit);
  return i === -1 ? LATENCY_BUCKETS_MS.length : i;
}

export const probeKey = (id: number) => `p:${id}`;

/**
 * GET /api/probes. One row per located probe: [id, lat, lng, cc, bucket],
 * bucket -1 while no result has been seen yet. `snapshotSeq` is the `world`
 * room's sequence number when the rows were read: a `p:<id>` delta in a
 * later frame is newer than the row.
 */
export interface ProbesResponse {
  snapshotSeq: number;
  probes: [id: number, lat: number, lng: number, cc: string, bucket: number][];
}

/**
 * GET /api/countries. Current health per country, from the latest closed
 * minute of routing and latency. Same `snapshotSeq` rule as probes.
 */
export interface CountriesResponse {
  snapshotSeq: number;
  countries: Record<string, { h: number; p50: number | null; probes: number }>;
}
