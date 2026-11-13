/**
 * Health score, 0 (broken) to 100 (healthy), for a country, a network or the
 * whole world over one time window. Version 1: it uses only what one window
 * shows on its own. Phase 2 adds baselines (the same hour on earlier days).
 *
 * It is the WORSE of two signals, so it is easy to explain:
 *
 *  - Routing: what share of route changes were withdrawals. Measured on live
 *    data (13 Nov 2026) the whole-world share is about 5%, so up to 25% is
 *    treated as normal churn, and 75% or more scores 0.
 *  - Reachability: what share of Atlas pings got no reply at all. Up to 5% is
 *    treated as normal, and 50% or more scores 0.
 *
 * A signal with too little data to judge (fewer than 20 route changes or 5
 * pings) counts as healthy, so a quiet country is not shown as broken.
 */
export interface HealthInput {
  ann: number;
  wd: number;
  pings: number;
  lost: number;
}

export const HEALTH_MIN_ROUTES = 20;
export const HEALTH_MIN_PINGS = 5;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function healthScore({ ann, wd, pings, lost }: HealthInput): number {
  let routing = 1;
  const routes = ann + wd;
  if (routes >= HEALTH_MIN_ROUTES) routing = 1 - clamp01((wd / routes - 0.25) / 0.5);

  let reach = 1;
  if (pings >= HEALTH_MIN_PINGS) reach = 1 - clamp01((lost / pings - 0.05) / 0.45);

  return Math.round(100 * Math.min(routing, reach));
}
