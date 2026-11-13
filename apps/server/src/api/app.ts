import express, { type ErrorRequestHandler, type Express } from 'express';
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
}

/** Build the Express app: health checks now, the REST API as later phases add it. */
export function createApp({ config, log, mongo, ingest, liveSockets }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

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
    });
  });

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
