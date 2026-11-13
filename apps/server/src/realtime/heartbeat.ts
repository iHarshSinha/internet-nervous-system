import { EV, rooms, type Delta, type DeltaValue, type Frame } from '@ins/shared';
import type { Ingest } from '../ingest/index.ts';
import type { LiveNamespace } from './live.ts';
import type { RoomSequencer } from './sequencer.ts';

/**
 * Once a second, send the `world` room a small frame: a tick, how many
 * browsers are connected and, per live source, events per second, mean lag
 * and how many upstream connections are up.
 *
 * It follows the delta rule: a value is sent only when it differs from the
 * value sent last time. The tick changes every second, so there is always a
 * frame, which also lets clients see that the link is alive.
 */
export function startHeartbeat(
  live: LiveNamespace,
  seq: RoomSequencer,
  ingest: Ingest | null,
  intervalMs = 1000,
): () => void {
  let tick = 0;
  const lastSent = new Map<string, DeltaValue>();
  const lastTotals = new Map<string, { events: number; lagSumMs: number; lagCount: number }>();

  // A client that has just joined has no state yet, so "unchanged" values
  // would never reach it. Until the snapshot protocol lands, forget what we
  // last sent whenever someone joins, so the next frame carries everything.
  const onJoin = (room: string) => {
    if (room === rooms.world) lastSent.clear();
  };
  live.adapter.on('join-room', onJoin);

  const timer = setInterval(() => {
    tick += 1;
    const changes: Delta[] = [['sys', 'tick', tick]];

    const put = (key: string, field: string, value: DeltaValue) => {
      const id = `${key}/${field}`;
      if (lastSent.get(id) === value) return;
      lastSent.set(id, value);
      changes.push([key, field, value]);
    };

    put('sys', 'sockets', live.sockets.size);

    if (ingest) {
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

      // The latest closed windows, by EVENT time: routing per second, and
      // latency per minute (Atlas results arrive minutes late, see benchmarks).
      const second = ingest.latest.second;
      if (second) {
        put('world', 'ann', second.world.ann);
        put('world', 'wd', second.world.wd);
        put('world', 'countries', second.countries);
      }
      const latency = ingest.latest.atlasMinute?.world;
      if (latency) {
        put('world', 'p50', latency.p50);
        put('world', 'p95', latency.p95);
      }
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
    }

    const frame: Frame = { r: rooms.world, s: seq.next(rooms.world), t: Date.now(), d: changes };
    live.to(rooms.world).emit(EV.frame, frame);
  }, intervalMs);

  return () => {
    clearInterval(timer);
    live.adapter.off('join-room', onJoin);
  };
}
