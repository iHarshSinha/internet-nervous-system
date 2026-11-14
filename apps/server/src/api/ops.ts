import { timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth/middleware.ts';
import type { IngestStatsStore } from '../db/ingestStats.ts';
import type { Registry } from 'prom-client';

export interface OpsDeps {
  secret: string;
  registry: Registry;
  /** A long random token a Prometheus scraper may use instead of an admin sign-in. */
  metricsToken?: string | undefined;
  stats: IngestStatsStore;
}

const DAY = 24 * 3600_000;

const historyQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive().optional(),
});

/** Constant-time comparison, so the token cannot be guessed from response times. */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * GET /metrics: Prometheus format, for admins or a scraper with METRICS_TOKEN.
 * GET /api/ops/history: per-minute pipeline and delivery numbers from
 * MongoDB, public (no personal data), so judges can see the /ops page.
 */
export function opsRouter({ secret, registry, metricsToken, stats }: OpsDeps): Router {
  const router = Router();
  const user = requireUser(secret);

  const scraperOrAdmin: RequestHandler = (req, res, next) => {
    const header = req.get('authorization') ?? '';
    if (metricsToken && header.startsWith('Bearer ') && sameToken(header.slice(7), metricsToken)) {
      next();
      return;
    }
    user(req, res, (err?: unknown) => (err ? next(err) : requireAdmin(req, res, next)));
  };

  router.get('/metrics', scraperOrAdmin, async (_req, res) => {
    res.set('Content-Type', registry.contentType).send(await registry.metrics());
  });

  // The server's clock, for a browser to estimate the difference to its own (the HUD).
  router.get('/api/time', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ t: Date.now() });
  });

  router.get('/api/ops/history', async (req, res) => {
    const parsed = historyQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'bad_request', message: 'from (ms) is required' } });
      return;
    }
    const to = parsed.data.to ?? Date.now();
    // At most a day per request: 3 rows a minute plus one per source.
    const from = Math.max(parsed.data.from, to - DAY);
    res.set('Cache-Control', 'no-store').json({ from, to, rows: await stats.between(from, to) });
  });

  return router;
}
