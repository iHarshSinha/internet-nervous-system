import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPLAY_SCENARIOS,
  replayCommandSchema,
  scenarioCommandSchema,
  type ScenarioId,
} from '@ins/shared';
import { Router } from 'express';
import { principalOf, requireAdmin, requireUser } from '../auth/middleware.ts';
import type { ReplayPlayer } from '../ingest/sources/replay.ts';
import { facebookPlan } from '../scenarios/facebook.ts';
import type { ScenarioPlan, ScenarioRunner } from '../scenarios/runner.ts';
import type { RunsStore } from '../scenarios/runs.ts';
import type { Logger } from '../logger.ts';

export interface AdminDeps {
  secret: string;
  replay: ReplayPlayer;
  scenarios: ScenarioRunner;
  runs: RunsStore;
  scenarioDir: string;
  log: Logger;
}

/** Admin-only controls. Every action is written to the log with who did it (an audit trail). */
export function adminRouter({
  secret,
  replay,
  scenarios,
  runs,
  scenarioDir,
  log,
}: AdminDeps): Router {
  const router = Router();
  const adminOnly = [requireUser(secret), requireAdmin];

  // Scenario files are small; each is read once and kept.
  let facebook: ScenarioPlan | null = null;
  const planFor = (id: ScenarioId): ScenarioPlan | null => {
    if (id === 'facebook-2021') {
      const file = join(scenarioDir, 'facebook-2021.ndjson.gz');
      if (!existsSync(file)) return null;
      facebook ??= facebookPlan(file);
      return facebook;
    }
    return null;
  };

  router.get('/api/admin/scenario', ...adminOnly, (_req, res) => {
    res.json(scenarios.snapshot());
  });

  router.post('/api/admin/scenario', ...adminOnly, (req, res) => {
    const parsed = scenarioCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'bad_request', message: 'Invalid scenario command' } });
      return;
    }
    const cmd = parsed.data;
    if (cmd.action === 'stop') {
      scenarios.stop();
    } else {
      const plan = planFor(cmd.scenario);
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

  router.get('/api/admin/replay', ...adminOnly, (_req, res) => {
    res.json(replay.snapshot());
  });

  router.post('/api/admin/replay', ...adminOnly, (req, res) => {
    const parsed = replayCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'bad_request', message: 'Invalid replay command' } });
      return;
    }
    const cmd = parsed.data;
    switch (cmd.action) {
      case 'start':
        replay.start(
          cmd.scenario,
          cmd.speed,
          cmd.from ?? REPLAY_SCENARIOS[cmd.scenario].defaultFrom,
        );
        break;
      case 'pause':
        replay.pause();
        break;
      case 'resume':
        replay.resume();
        break;
      case 'stop':
        replay.stop();
        break;
      case 'speed':
        replay.setSpeed(cmd.speed);
        break;
    }
    log.info({ admin: principalOf(res).email, command: cmd }, 'admin: replay command');
    res.json(replay.snapshot());
  });

  return router;
}
