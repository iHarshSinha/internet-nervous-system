import { rooms, type DeltaValue, type ScenarioStatus } from '@ins/shared';
import type { Ingest } from '../ingest/index.ts';
import type { Broadcaster } from './broadcaster.ts';
import type { LiveNamespace } from './live.ts';

/**
 * Once a second, stage the `world` room's status values: a tick, how many
 * browsers are connected and, per live source, events per second, mean lag,
 * rejected messages and how many upstream connections are up.
 *
 * The broadcaster sends each value only when it has changed. The tick changes
 * every second, so the world room always gets a frame, which also tells
 * clients the link is alive.
 */
export function startHeartbeat(
  live: LiveNamespace,
  broadcaster: Broadcaster,
  ingest: Ingest | null,
  intervalMs = 1000,
  scenario?: () => ScenarioStatus,
): () => void {
  let tick = 0;
  const lastTotals = new Map<string, { events: number; lagSumMs: number; lagCount: number }>();
  const put = (key: string, field: string, value: DeltaValue) =>
    broadcaster.set(rooms.world, key, field, value);

  const timer = setInterval(() => {
    tick += 1;
    put('sys', 'tick', tick);
    // Everyone sees when a scenario is being injected.
    const s = scenario?.();
    if (s) {
      put('scenario', 'state', s.state);
      put('scenario', 'id', s.id);
      put('scenario', 'startedAt', s.startedAt);
      put('scenario', 'durationMs', s.durationMs);
      put('scenario', 'phase', s.phase);
      put('scenario', 'target', s.target);
    }
    put('sys', 'sockets', live.sockets.size);
    if (!ingest) return;

    const perSecond = 1000 / intervalMs;
    for (const source of ingest.stats.sources()) {
      const now = ingest.stats.of(source);
      const before = lastTotals.get(source) ?? { events: 0, lagSumMs: 0, lagCount: 0 };
      lastTotals.set(source, {
        events: now.events,
        lagSumMs: now.lagSumMs,
        lagCount: now.lagCount,
      });

      const key = `src:${source}`;
      put(key, 'eps', Math.round((now.events - before.events) * perSecond));
      const lagCount = now.lagCount - before.lagCount;
      if (lagCount > 0) {
        // Mean age of this second's events on arrival, rounded to 0.1 s so
        // tiny wobbles do not count as a change.
        const meanMs = (now.lagSumMs - before.lagSumMs) / lagCount;
        put(key, 'lag', Math.round(meanMs / 100) / 10);
      }
      put(key, 'rejected', now.rejected);
    }

    // Latency is per minute: Atlas results arrive minutes late (see benchmarks).
    const latency = ingest.latest.atlasMinute?.world;
    if (latency) {
      put('world', 'p50', latency.p50);
      put('world', 'p95', latency.p95);
    }
    const second = ingest.latest.second;
    if (second) {
      put('world', 'ann', second.world.ann);
      put('world', 'wd', second.world.wd);
      put('world', 'countries', second.countries);
    }

    // Everyone sees when a replay is running, so recorded data is never mistaken for live.
    const r = ingest.replay.snapshot();
    put('replay', 'state', r.state);
    put('replay', 'scenario', r.scenario);
    put('replay', 'speed', r.speed);
    put('replay', 'clock', r.clock);

    const counters = ingest.pipeline.counters;
    put('pipe', 'dup', counters.duplicates);
    put('pipe', 'late', counters.lateMinute);
    put('pipe', 'future', counters.future);
    put('pipe', 'prefixes', ingest.pipeline.origins.size);

    const connections = ingest.connections();
    if (connections.length > 0) {
      put('sys', 'upstreams', connections.length);
      put('sys', 'upstreamsUp', connections.filter((c) => c.connected).length);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
