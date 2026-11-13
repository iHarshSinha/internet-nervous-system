import {
  atlasFrameSchema,
  atlasPingSchema,
  atlasProbeStatusSchema,
  type EventEnvelope,
} from '@ins/shared';
import type { Logger } from '../../logger.ts';
import type { IngestStats } from '../stats.ts';
import { normaliseAtlasPing, normaliseAtlasStatus } from './normalise.ts';
import { UpstreamSocket } from './upstream-socket.ts';

export interface AtlasOptions {
  /** Built-in ping measurements to follow (1001, 1008, 1006 ping root DNS servers). */
  measurements: number[];
  stats: IngestStats;
  log: Logger;
  sink(events: EventEnvelope[]): void;
  /** Overridable for tests. */
  url?: string;
}

/**
 * RIPE Atlas: ping results from thousands of probes, plus probe connect and
 * disconnect events. Plain WebSocket; every frame is an `[event, payload]` pair.
 */
export function createAtlasSource(opts: AtlasOptions): UpstreamSocket {
  const onText = (text: string, receivedAt: number) => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return opts.stats.rejected('atlas');
    }

    const frame = atlasFrameSchema.safeParse(json);
    if (!frame.success) return opts.stats.rejected('atlas');
    const [event, payload] = frame.data;

    if (event === 'atlas_result') {
      const ping = atlasPingSchema.safeParse(payload);
      if (!ping.success) return opts.stats.rejected('atlas');
      opts.stats.accepted('atlas', 1, ping.data.timestamp * 1000, receivedAt);
      opts.sink([normaliseAtlasPing(ping.data, receivedAt)]);
    } else if (event === 'atlas_probestatus') {
      const status = atlasProbeStatusSchema.safeParse(payload);
      if (!status.success) return opts.stats.rejected('atlas');
      opts.stats.accepted('atlas', 1, status.data.timestamp * 1000, receivedAt);
      opts.sink([normaliseAtlasStatus(status.data, receivedAt)]);
    } else if (event !== 'atlas_subscribed') {
      // Atlas tells us here when it had to drop messages because we were slow.
      // That is upstream backpressure, so it is counted, never ignored.
      opts.stats.warning('atlas');
      opts.log.warn({ source: 'atlas', message: text.slice(0, 300) }, 'Atlas stream notice');
    }
  };

  return new UpstreamSocket({
    name: 'atlas',
    url: opts.url ?? 'wss://atlas-stream.ripe.net/stream/',
    log: opts.log,
    subscribe: (send) => {
      for (const msm of opts.measurements) {
        send(['atlas_subscribe', { streamType: 'result', msm }]);
      }
      send(['atlas_subscribe', { streamType: 'probestatus' }]);
    },
    onText,
  });
}
