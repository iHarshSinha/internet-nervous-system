import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Every setting comes from environment variables and is validated once at
 * startup. A bad value stops the server with a readable message instead of
 * causing a strange failure later.
 */
/** Docker Compose passes unset variables as empty strings; treat those as not set. */
const emptyIsUnset = (v: unknown) => (v === '' ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/ins'),
  /** `live` reads the real feeds; `replay` plays recorded events through the same pipeline. */
  MODE: z.enum(['live', 'replay']).default('live'),

  /** Set to "off" to run the server without connecting to the live feeds. */
  INGEST: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /**
   * Run the feeds, pipeline and detectors in their own worker thread, so
   * bursts never delay HTTP and Socket.IO. "off" runs them in the main thread
   * (same code, same messages; used by tests).
   */
  INGEST_THREAD: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /**
   * Events the ingest queue holds before it starts shedding route
   * announcements (sampling starts at 70%, see ingest/pipeline/queue.ts).
   * The pipeline handles roughly 580,000 events a second on one core, so
   * 100,000 is a fraction of a second of work but half a minute of live traffic.
   */
  INGEST_QUEUE_MAX: z.coerce.number().int().min(100).max(5_000_000).default(100_000),
  // ---- Delivery optimisations. Each can be switched off to measure what it saves (load test T5).
  /** Socket.IO wire format: MessagePack (binary, smaller) or JSON (Socket.IO's default). */
  SOCKET_PARSER: z.enum(['msgpack', 'json']).default('msgpack'),
  /** Changes per room are merged and sent every this many ms; 0 sends every change at once. */
  CONFLATE_MS: z.coerce.number().int().min(0).max(10_000).default(500),
  /** "rooms": a frame goes only to its room. "all": to every client (the naive baseline). */
  BROADCAST: z.enum(['rooms', 'all']).default('rooms'),
  /** Clients whose send buffer keeps growing get a merged frame every 2 s instead. */
  SLOW_CLIENTS: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /** Set to "off" to skip downloading network and probe reference data. */
  REFDATA: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /** Per minute, store history for at most this many of the busiest networks. */
  METRICS_ASN_LIMIT: z.coerce.number().int().min(0).max(5000).default(300),
  /** RIS Live asks every client to identify itself. */
  RIS_CLIENT_NAME: z.string().min(1).max(64).default('internet-nervous-system'),
  /**
   * Route collectors to follow, one upstream connection each. Measured in
   * Phase 0: rrc00 alone is about 600 messages (1,400 events) per second.
   */
  RIS_COLLECTORS: z
    .string()
    .default('rrc00,rrc10,rrc11,rrc14')
    .transform((v) => v.split(',').map((c) => c.trim()))
    .pipe(
      z
        .array(z.string().regex(/^rrc\d{2}$/, 'expected names like rrc00'))
        .min(1)
        .max(12),
    ),
  /** Atlas built-in ping measurements (root DNS servers). */
  ATLAS_MEASUREMENTS: z
    .string()
    .default('1001,1008,1006')
    .transform((v) => v.split(',').map((n) => Number(n.trim())))
    .pipe(z.array(z.number().int().positive()).min(1).max(20)),

  /** The Facebook outage recording made by `pnpm replay-prep`. */
  REPLAY_FACEBOOK_FILE: z
    .string()
    .default(
      fileURLToPath(
        new URL('../../../deploy/seed/replay/facebook-20211004.ndjson.gz', import.meta.url),
      ),
    ),

  /** Small scenario files (committed) that admins can inject on demand. */
  SCENARIO_DIR: z
    .string()
    .default(fileURLToPath(new URL('../../../deploy/seed/scenarios/', import.meta.url))),

  // ---- Cloudflare Radar (optional: without a token the Radar layer stays off)
  CLOUDFLARE_API_TOKEN: z.preprocess(emptyIsUnset, z.string().min(20).max(200).optional()),
  /** How often to poll Radar events, and attack pairs (which Radar updates every 15 minutes). */
  RADAR_EVENTS_EVERY_S: z.coerce.number().int().min(60).max(3600).default(180),
  RADAR_PAIRS_EVERY_S: z.coerce.number().int().min(300).max(3600).default(900),

  // ---- sign-in and access control
  /** Google OAuth client ID. Without it, sign-in is hidden and the app stays visitor-only. */
  GOOGLE_CLIENT_ID: z.preprocess(
    emptyIsUnset,
    z
      .string()
      .regex(/^[\w-]+\.apps\.googleusercontent\.com$/, 'expected <id>.apps.googleusercontent.com')
      .optional(),
  ),
  /** Signs our own session tokens. Recommended in production (at least 32 characters). */
  JWT_SECRET: z.preprocess(
    emptyIsUnset,
    z.string().min(32, 'use at least 32 characters (openssl rand -hex 32)').optional(),
  ),
  /** Google accounts that get the admin role, comma-separated. */
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Send the refresh cookie only over HTTPS. Defaults to on in production. */
  COOKIE_SECURE: z.preprocess(emptyIsUnset, z.enum(['on', 'off']).optional()),

  // ---- rate limits (starting values from docs/PLAN.md "Security")
  API_RATE_PER_MIN: z.coerce.number().int().min(1).default(100),
  AUTH_RATE_PER_MIN: z.coerce.number().int().min(1).default(10),
  SOCKET_CONNECTIONS_PER_MIN: z.coerce.number().int().min(1).default(20),
  SOCKET_MESSAGES_PER_SEC: z.coerce.number().min(0.1).default(5),
});

export type Config = Omit<z.infer<typeof envSchema>, 'JWT_SECRET' | 'COOKIE_SECURE'> & {
  JWT_SECRET: string;
  /** True when no JWT_SECRET was given and a random one is in use. */
  JWT_SECRET_GENERATED: boolean;
  COOKIE_SECURE: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  const c = parsed.data;
  return {
    ...c,
    // Without a configured secret a random one is used. That is still secure;
    // sessions simply end when the server restarts. Startup logs a warning.
    JWT_SECRET: c.JWT_SECRET ?? randomBytes(32).toString('hex'),
    JWT_SECRET_GENERATED: c.JWT_SECRET === undefined,
    COOKIE_SECURE: c.COOKIE_SECURE ? c.COOKIE_SECURE === 'on' : c.NODE_ENV === 'production',
  };
}
