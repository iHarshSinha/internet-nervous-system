import { z } from 'zod';

/**
 * Every setting comes from environment variables and is validated once at
 * startup. A bad value stops the server with a readable message instead of
 * causing a strange failure later.
 */
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
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  return parsed.data;
}
