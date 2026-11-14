import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPLAY_SCENARIOS,
  replayCommandSchema,
  scenarioCommandSchema,
  type ReplayScenario,
  type ReplayStatus,
  type ScenarioId,
} from '@ins/shared';
import { Router } from 'express';
import { principalOf, requireAdmin, requireUser } from '../auth/middleware.ts';
import { AttackError, attackPlan, type AttackDeps } from '../scenarios/attacks.ts';
import { facebookPlan } from '../scenarios/facebook.ts';
import type { ScenarioPlan, ScenarioRunner } from '../scenarios/runner.ts';
import type { RunsStore } from '../scenarios/runs.ts';
import type { Logger } from '../logger.ts';

export interface AdminDeps {
  secret: string;
  /** Full-file replay controls (the player runs on the ingest side). */
  replay: {
    status(): Promise<ReplayStatus>;
    start(scenario: ReplayScenario, speed: number, from: number): Promise<ReplayStatus>;
    pause(): Promise<ReplayStatus>;
    resume(): Promise<ReplayStatus>;
    stop(): Promise<ReplayStatus>;
    setSpeed(speed: number): Promise<ReplayStatus>;
  };
  scenarios: ScenarioRunner;
  runs: RunsStore;
  scenarioDir: string;
  /** Live state the synthetic attacks are built from. */
  attacks: AttackDeps;
  log: Logger;
}

/** Admin-only controls. Every action is written to the log with who did it (an audit trail). */
export function adminRouter({
  secret,
  replay,
  scenarios,
  runs,
  scenarioDir,
  attacks,
  log,
}: AdminDeps): Router {
  const router = Router();
  const adminOnly = [requireUser(secret), requireAdmin];

  // Scenario files are small; each is read once and kept.
  let facebook: ScenarioPlan | null = null;
  const recorded = (id: ScenarioId): ScenarioPlan | null => {
    if (id !== 'facebook-2021') return null;
    const file = join(scenarioDir, 'facebook-2021.ndjson.gz');
    if (!existsSync(file)) return null;
    facebook ??= facebookPlan(file);
    return facebook;
  };

  router.get('/api/admin/scenario', ...adminOnly, (_req, res) => {
    res.json(scenarios.snapshot());
  });

  router.post('/api/admin/scenario', ...adminOnly, async (req, res) => {
    const parsed = scenarioCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'bad_request', message: 'Invalid scenario command' } });
      return;
    }
    const cmd = parsed.data;
    if (cmd.action === 'stop') {
      scenarios.stop();
    } else {
      let plan: ScenarioPlan | null;
      try {
        plan =
          cmd.scenario === 'facebook-2021'
            ? recorded(cmd.scenario)
            : await attackPlan(cmd.scenario, { asn: cmd.asn, cc: cmd.cc }, attacks);
      } catch (err) {
        if (!(err instanceof AttackError)) throw err;
        res.status(422).json({ error: { code: 'bad_target', message: err.message } });
        return;
      }
      if (!plan) {
        res.status(404).json({ error: { code: 'not_found', message: 'Scenario file is missing' } });
        return;
      }
      scenarios.start(plan);
    }
    log.info({ admin: principalOf(res).email, command: cmd }, 'admin: scenario command');
    res.json(scenarios.snapshot());
  });

  // Public: which stretches of time were simulated, so charts can mark them.
  router.get('/api/scenarios/runs', async (req, res) => {
    const now = Date.now();
    const from = Number(req.query.from) || now - 24 * 3600_000;
    const to = Number(req.query.to) || now;
    res.json(await runs.between(from, to));
  });

  router.get('/api/admin/replay', ...adminOnly, async (_req, res) => {
    res.json(await replay.status());
  });

  router.post('/api/admin/replay', ...adminOnly, async (req, res) => {
    const parsed = replayCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'bad_request', message: 'Invalid replay command' } });
      return;
    }
    const cmd = parsed.data;
    let status: ReplayStatus;
    switch (cmd.action) {
      case 'start':
        status = await replay.start(
          cmd.scenario,
          cmd.speed,
          cmd.from ?? REPLAY_SCENARIOS[cmd.scenario].defaultFrom,
        );
        break;
      case 'pause':
        status = await replay.pause();
        break;
      case 'resume':
        status = await replay.resume();
        break;
      case 'stop':
        status = await replay.stop();
        break;
      case 'speed':
        status = await replay.setSpeed(cmd.speed);
        break;
    }
    log.info({ admin: principalOf(res).email, command: cmd }, 'admin: replay command');
    res.json(status);
  });

  return router;
}
