import type { EventEnvelope, ScenarioId, ScenarioStatus } from '@ins/shared';
import type { Logger } from '../logger.ts';

/** One moment of a scenario: the events of one message, `at` ms after the start. */
export interface ScenarioStep {
  at: number;
  batch: EventEnvelope[];
}

/** A scenario ready to play: steps in order, plus named phases for the progress display. */
export interface ScenarioPlan {
  id: ScenarioId;
  steps: ScenarioStep[];
  durationMs: number;
  phases: { name: string; at: number }[];
}

export interface RunnerOptions {
  log: Logger;
  /** Where the events go: the live pipeline. */
  sink(batch: EventEnvelope[], now: number): void;
  onStart?(run: number, plan: ScenarioPlan, startedAt: number): void;
  onEnd?(run: number, endedAt: number): void;
  now?: () => number;
}

const TICK_MS = 25;

/**
 * Plays a scenario into the live stream, starting now.
 *
 * Every event is stamped with the current time (so windows, rooms and
 * detectors treat it as happening now), gets a fresh ID for this run
 * (`replay:s<run>:...`), and is marked `simulated: true` with the scenario's
 * name, so nothing it produces can be mistaken for real live traffic.
 */
export class ScenarioRunner {
  private readonly opts: RunnerOptions;
  private readonly now: () => number;
  private status: ScenarioStatus = {
    state: 'idle',
    id: null,
    startedAt: null,
    durationMs: 0,
    phase: null,
    run: 0,
    emitted: 0,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private plan: ScenarioPlan | null = null;
  private next = 0;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  snapshot(): ScenarioStatus {
    return { ...this.status };
  }

  start(plan: ScenarioPlan): void {
    this.stop();
    const run = this.status.run + 1;
    const startedAt = this.now();
    this.plan = plan;
    this.next = 0;
    this.status = {
      state: 'running',
      id: plan.id,
      startedAt,
      durationMs: plan.durationMs,
      phase: plan.phases[0]?.name ?? null,
      run,
      emitted: 0,
    };
    this.opts.log.info({ scenario: plan.id, run }, 'scenario started');
    this.opts.onStart?.(run, plan, startedAt);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.status.state === 'running') {
      this.opts.onEnd?.(this.status.run, this.now());
      this.opts.log.info({ scenario: this.status.id, run: this.status.run }, 'scenario ended');
    }
    this.status = { ...this.status, state: 'idle', phase: null };
    this.plan = null;
  }

  private tick(): void {
    const plan = this.plan;
    if (!plan || this.status.startedAt === null) return;
    const now = this.now();
    const elapsed = now - this.status.startedAt;
    const run = this.status.run;

    while (this.next < plan.steps.length && plan.steps[this.next]!.at <= elapsed) {
      const step = plan.steps[this.next++]!;
      const batch = step.batch.map((e) => ({
        ...e,
        src: 'replay' as const,
        eid: `replay:s${run}:${e.eid.replace(/^replay:/, '')}`,
        ts: now,
        its: now,
        data: {
          ...e.data,
          simulated: true,
          scenario: plan.id,
          ...(e.src === 'replay' && { origTs: e.ts }),
        },
      }));
      this.opts.sink(batch, now);
      this.status.emitted += batch.length;
    }
    this.status.phase = [...plan.phases].reverse().find((p) => p.at <= elapsed)?.name ?? null;
    if (elapsed >= plan.durationMs) this.stop();
  }
}
