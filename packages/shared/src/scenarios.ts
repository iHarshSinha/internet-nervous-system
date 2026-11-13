import { z } from 'zod';
import { asnSchema, countryCodeSchema } from './primitives.ts';

/**
 * Scenarios an admin can trigger. Each injects a short, labelled burst of
 * events into the live stream, so the app can be seen reacting on cue, then
 * everything returns to normal. Every event carries `simulated: true`, and
 * every viewer sees a SIMULATION badge while one runs.
 *
 * `target` says what the admin picks: a network (`asn`), a country (`country`),
 * or nothing (the recorded Facebook outage has its own).
 */
export const SCENARIOS = {
  'facebook-2021': {
    title: 'Facebook outage (recorded)',
    short: 'Facebook 2021',
    target: null,
    /** Shown on screen next to the scenario, so viewers know what is real. */
    note: 'Real routing data recorded on 4 Oct 2021 (15:39–15:54 UTC), played 10× faster. The recovery is simulated.',
    asn: 32934,
    cc: 'US',
  },
  outage: {
    title: 'Network outage',
    short: 'Outage',
    target: 'asn',
    note: 'Simulated: routers worldwide withdraw every route to the network, then it comes back.',
    asn: null,
    cc: null,
  },
  hijack: {
    title: 'Route hijack',
    short: 'Hijack',
    target: 'asn',
    note: 'Simulated: a stranger network (AS64511, reserved for examples) announces the target’s address blocks.',
    asn: null,
    cc: null,
  },
  latency: {
    title: 'Latency surge',
    short: 'Latency',
    target: 'country',
    note: 'Simulated: the country’s RIPE Atlas probes report slow or lost pings.',
    asn: null,
    cc: null,
  },
  dropout: {
    title: 'Probe dropout',
    short: 'Dropout',
    target: 'country',
    note: 'Simulated: half of the country’s RIPE Atlas probes disconnect at once.',
    asn: null,
    cc: null,
  },
  blackout: {
    title: 'Country blackout',
    short: 'Blackout',
    target: 'country',
    note: 'Simulated: the country’s biggest networks withdraw their routes while its probes slow down and drop off.',
    asn: null,
    cc: null,
  },
} as const;
export type ScenarioId = keyof typeof SCENARIOS;
export const SCENARIO_IDS = Object.keys(SCENARIOS) as [ScenarioId, ...ScenarioId[]];

/** The simulated attacker in the hijack scenario: an ASN reserved for documentation (RFC 5398). */
export const SIMULATED_HIJACKER = 64511;

/** Body of POST /api/admin/scenario. The target is checked against the scenario on the server. */
export const scenarioCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    scenario: z.enum(SCENARIO_IDS),
    asn: asnSchema.optional(),
    cc: countryCodeSchema.optional(),
  }),
  z.object({ action: z.literal('stop') }),
]);
export type ScenarioCommand = z.infer<typeof scenarioCommandSchema>;

/** What the world room carries under key "scenario", and GET /api/admin/scenario returns. */
export interface ScenarioStatus {
  state: 'idle' | 'running';
  id: ScenarioId | null;
  /** Server time the run started, in ms; with durationMs the client draws progress. */
  startedAt: number | null;
  durationMs: number;
  /** Current phase name, for example "outage" or "recovery". */
  phase: string | null;
  /** What it targets, for display: "AS32934" or "BR". */
  target: string | null;
  run: number;
  emitted: number;
}

/** A finished or running scenario, kept so charts can mark the stretch as simulated. */
export interface ScenarioRun {
  id: string;
  scenario: ScenarioId;
  startedAt: number;
  endedAt: number | null;
  asn: number | null;
  cc: string | null;
}
