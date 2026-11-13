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
