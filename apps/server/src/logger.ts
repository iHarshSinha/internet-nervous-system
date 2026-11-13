import { pino, type Logger } from 'pino';
import type { Config } from './config.ts';

export type { Logger };

/** JSON logs in production (one object per line); readable coloured logs in development. */
export function createLogger(config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>): Logger {
  return pino({
    level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } },
    }),
  });
}
