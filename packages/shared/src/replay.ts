import { z } from 'zod';

/** The recorded incidents the admin can replay. */
export const REPLAY_SCENARIOS = {
  'facebook-2021': {
    title: 'Facebook outage, 4 October 2021',
    /** Where playback starts by default: nine minutes before the withdrawals begin. */
    defaultFrom: Date.UTC(2021, 9, 4, 15, 30),
    /** When the incident itself starts, for the progress bar. */
    incidentAt: Date.UTC(2021, 9, 4, 15, 39),
    /** Last moment in the recording. */
    end: Date.UTC(2021, 9, 4, 16, 30),
    asn: 32934,
  },
} as const;
export type ReplayScenario = keyof typeof REPLAY_SCENARIOS;

export const REPLAY_SPEEDS = [1, 2, 5, 10, 20, 50] as const;

/** Body of POST /api/admin/replay. */
export const replayCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    scenario: z.enum(Object.keys(REPLAY_SCENARIOS) as [ReplayScenario]),
    speed: z.union(
      REPLAY_SPEEDS.map((s) => z.literal(s)) as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
    ),
    /** Start from this original time (ms); defaults to the scenario's start. */
    from: z.number().int().optional(),
  }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('stop') }),
  z.object({
    action: z.literal('speed'),
    speed: z.union(
      REPLAY_SPEEDS.map((s) => z.literal(s)) as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
    ),
  }),
]);
export type ReplayCommand = z.infer<typeof replayCommandSchema>;

export const REPLAY_STATES = ['idle', 'loading', 'playing', 'paused', 'finished', 'error'] as const;
export type ReplayState = (typeof REPLAY_STATES)[number];

/** What GET /api/admin/replay returns, and what the world room carries under key "replay". */
export interface ReplayStatus {
  state: ReplayState;
  scenario: ReplayScenario | null;
  speed: number;
  /** The original (2021) time currently being played, in ms. */
  clock: number | null;
  /** Events sent into the pipeline in this run. */
  emitted: number;
  /** Run number: each run gets fresh event IDs, so replaying twice is not "duplicate". */
  run: number;
  error: string | null;
}
