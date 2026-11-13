import express, { type ErrorRequestHandler, type Express, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { Config } from '../config.ts';
import type { Mongo } from '../db/client.ts';
import type { Ingest } from '../ingest/index.ts';
import type { Logger } from '../logger.ts';

export interface AppDeps {
  config: Config;
  log: Logger;
  mongo: Pick<Mongo, 'ping'>;
  ingest: Ingest;
  /** Number of browsers connected to the public namespace right now. */
  liveSockets: () => number;
  /** Feature routers (history, and later auth, watchlists, ...). */
  routes?: Router[];
  /** Extra fields for /api/status. */
  extraStatus?: () => Record<string, unknown>;
}

/** Build the Express app: health checks now, the REST API as later phases add it. */
export function createApp({
  config,
  log,
  mongo,
  ingest,
  liveSockets,
  routes = [],
  extraStatus,
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // One proxy sits in front (Vite in development, Caddy or Railway in
  // production), so the client's address is the first forwarded one.
  app.set('trust proxy', 1);
  // Standard security headers. The content security policy is set where the
  // web page itself is served (Caddy now; the server, once it serves the page).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '256kb' }));

  const tooMany = (message: string) => ({ error: { code: 'rate_limited', message } });
  // Signing in is the endpoint worth hammering, so it gets its own, tighter limit.
  // Refresh is not: its token is 256 random bits, and every page load calls it.
  app.use(
    '/api/auth/google',
    rateLimit({
      windowMs: 60_000,
      limit: config.AUTH_RATE_PER_MIN,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: tooMany('Too many sign-in attempts; try again in a minute'),
    }),
  );
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: config.API_RATE_PER_MIN,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: tooMany('Too many requests; slow down'),
    }),
  );

  // Liveness: the process is up. Docker's HEALTHCHECK calls this.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Readiness: the things we depend on are reachable.
  app.get('/readyz', async (_req, res) => {
    const mongoOk = await mongo.ping();
    res.status(mongoOk ? 200 : 503).json({ ok: mongoOk, mongo: mongoOk });
  });

  app.get('/api/status', (_req, res) => {
    res.json({
      name: 'internet-nervous-system',
      mode: config.MODE,
      serverTime: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      liveSockets: liveSockets(),
      // One entry per upstream connection, and running totals per source.
      upstreams: ingest.connections(),
      sources: Object.fromEntries(ingest.stats.sources().map((s) => [s, ingest.stats.of(s)])),
      // Dedupe, lateness and window counters, and the latest closed windows.
      pipeline: ingest.pipeline.snapshot(),
      latest: ingest.latest,
      ...extraStatus?.(),
    });
  });

  for (const router of routes) app.use(router);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such route' } });
  });

  // Last resort. Log the real error, but never send a stack trace to the client.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status =
      typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log.error({ err }, 'unhandled request error');
    res.status(status).json({
      error: {
        code: status === 500 ? 'internal' : 'bad_request',
        message: status === 500 ? 'Internal server error' : 'Bad request',
      },
    });
  };
  app.use(onError);

  return app;
}
