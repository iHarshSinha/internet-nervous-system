import { REPLAY_SCENARIOS, replayCommandSchema } from '@ins/shared';
import { Router } from 'express';
import { principalOf, requireAdmin, requireUser } from '../auth/middleware.ts';
import type { ReplayPlayer } from '../ingest/sources/replay.ts';
import type { Logger } from '../logger.ts';

export interface AdminDeps {
  secret: string;
  replay: ReplayPlayer;
  log: Logger;
}

/** Admin-only controls. Every action is written to the log with who did it (an audit trail). */
export function adminRouter({ secret, replay, log }: AdminDeps): Router {
  const router = Router();
  const adminOnly = [requireUser(secret), requireAdmin];

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
