import { z } from 'zod';

/**
 * Scenarios an admin can trigger. Each injects a short, labelled burst of
 * events into the live stream, so the app can be seen reacting on cue, then
 * everything returns to normal.
 */
export const SCENARIOS = {
  'facebook-2021': {
    title: 'Facebook outage',
    /** Shown on screen next to the scenario, so viewers know what is real. */
    note: 'Real routing data recorded on 4 Oct 2021 (15:39–15:54 UTC), played 10× faster. The recovery is simulated.',
    asn: 32934,
    cc: 'US',
  },
} as const;
export type ScenarioId = keyof typeof SCENARIOS;
export const SCENARIO_IDS = Object.keys(SCENARIOS) as [ScenarioId, ...ScenarioId[]];

/** Body of POST /api/admin/scenario. */
export const scenarioCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), scenario: z.enum(SCENARIO_IDS) }),
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
