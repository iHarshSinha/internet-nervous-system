import { risMessageSchema, type EventEnvelope } from '@ins/shared';
import type { Logger } from '../../logger.ts';
import type { IngestStats } from '../stats.ts';
import { normaliseRis } from './normalise.ts';
import { UpstreamSocket } from './upstream-socket.ts';

export interface RisOptions {
  /** RIS Live asks every client to name itself. */
  clientName: string;
  /** Route collectors to follow, for example ["rrc00", "rrc10"]. */
  collectors: string[];
  stats: IngestStats;
  log: Logger;
  /** Receives the events of each message. */
  sink(events: EventEnvelope[]): void;
  /** Overridable for tests. */
  url?: string;
}

/**
 * RIS Live: BGP routing updates.
 *
 * One connection PER COLLECTOR, each filtered to that collector's UPDATE
 * messages. Phase 0 measured that a single unfiltered connection runs 40+
 * seconds behind, is cut off repeatedly and delivers only about a tenth of a
 * collector's messages, while a per-collector connection keeps up.
 */
export function createRisSource(opts: RisOptions): UpstreamSocket[] {
  const url =
    opts.url ?? `wss://ris-live.ripe.net/v1/ws/?client=${encodeURIComponent(opts.clientName)}`;

  const onText = (text: string, receivedAt: number) => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return opts.stats.rejected('ris');
    }

    const type = (json as { type?: unknown } | null)?.type;
    if (type === 'ris_error') {
      opts.stats.warning('ris');
      opts.log.warn({ source: 'ris', message: text.slice(0, 300) }, 'RIS Live reported an error');
      return;
    }
    if (type !== 'ris_message') return; // pong, subscribe confirmation

    const parsed = risMessageSchema.safeParse(json);
    if (!parsed.success) return opts.stats.rejected('ris');

    const events = normaliseRis(parsed.data.data, receivedAt);
    opts.stats.accepted('ris', events.length, parsed.data.data.timestamp * 1000, receivedAt);
    if (events.length > 0) opts.sink(events);
  };

  return opts.collectors.map(
    (collector) =>
      new UpstreamSocket({
        name: `ris:${collector}`,
        url,
        log: opts.log,
        subscribe: (send) =>
          send({ type: 'ris_subscribe', data: { host: collector, type: 'UPDATE' } }),
        onText,
      }),
  );
}
