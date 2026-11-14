import type { DeltaValue, Frame } from '@ins/shared';
import { create } from 'zustand';

/** One second of the server's numbers, for the live charts. */
export interface OpsPoint {
  /** Events in per second, all sources. */
  eps: number;
  /** Events processed per second. */
  rps: number;
  /** Bytes sent to browsers per second. */
  bps: number;
  /** Processing delay p99 and window-to-publish p50, ms. */
  delayP99: number;
  pubP50: number;
  /** Event-loop delay p99 of each thread, ms. */
  loopMain: number;
  loopIngest: number;
  queueDepth: number;
}

/** Five minutes of seconds. */
const KEEP = 300;

interface OpsState {
  /** Latest value of every key and field of the `stats` room (see server realtime/stats.ts). */
  now: Record<string, Record<string, DeltaValue>>;
  /** Time-keyed (ms) so a re-sent second replaces itself. */
  points: Map<number, OpsPoint>;
  version: number;
}

export const useOps = create<OpsState>(() => ({ now: {}, points: new Map(), version: 0 }));

const n = (v: DeltaValue | undefined) => (typeof v === 'number' ? v : 0);

/** Apply a frame of the `stats` room: merge the values, then record this second's point. */
export function onStatsFrame(frame: Frame): void {
  const { now, points } = useOps.getState();
  const next = { ...now };
  for (const [key, field, value] of frame.d) next[key] = { ...next[key], [field]: value };

  let eps = 0;
  for (const [key, fields] of Object.entries(next)) if (key.startsWith('in:')) eps += n(fields.eps);
  const t = frame.t - (frame.t % 1000);
  points.set(t, {
    eps,
    rps: n(next.pipe?.rps),
    bps: n(next.out?.bps),
    delayP99: n(next.delay?.p99),
    pubP50: n(next.pub?.p50),
    loopMain: n(next.loop?.main),
    loopIngest: n(next.loop?.ingest),
    queueDepth: n(next.queue?.depth),
  });
  if (points.size > KEEP + 30) {
    const keys = [...points.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - KEEP)) points.delete(k);
  }
  useOps.setState((s) => ({ now: next, version: s.version + 1 }));
}

/** Leaving the page: forget, so a later visit starts clean (rates restart on the server too). */
export function resetOps(): void {
  useOps.setState({ now: {}, points: new Map(), version: 0 });
}
