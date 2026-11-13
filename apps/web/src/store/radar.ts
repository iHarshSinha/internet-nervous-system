import {
  PAIRS_KEY,
  type AttackPair,
  type Frame,
  type RadarEvent,
  type RadarResponse,
} from '@ins/shared';
import { create } from 'zustand';

/*
 * Cloudflare Radar, live. The `arcs` room carries new Radar events
 * (["radar:<type>:<id>", "v", event]) and the latest attack pairs
 * (["pairs", "v", [...]]). Events are keyed by ID, so the history load and
 * live frames can arrive in any order without duplicates.
 */

interface RadarState {
  /** null until we know; false when the server has no Cloudflare token. */
  enabled: boolean | null;
  events: Record<string, RadarEvent>;
  pairs: AttackPair[];
}

export const useRadar = create<RadarState>(() => ({ enabled: null, events: {}, pairs: [] }));

export function onArcsFrame(frame: Frame): void {
  let events: Record<string, RadarEvent> | null = null;
  let pairs: AttackPair[] | null = null;
  for (const [key, field, value] of frame.d) {
    if (field !== 'v') continue;
    if (key === PAIRS_KEY && Array.isArray(value)) pairs = value as AttackPair[];
    else if (key.startsWith('radar:') && value && typeof value === 'object') {
      events ??= { ...useRadar.getState().events };
      const e = value as unknown as RadarEvent;
      events[e.id] = e;
    }
  }
  if (events || pairs) {
    useRadar.setState((s) => ({ events: events ?? s.events, pairs: pairs ?? s.pairs }));
  }
}

export async function loadRadar(): Promise<void> {
  const res = await fetch('/api/radar').catch(() => null);
  if (!res?.ok) return;
  const body = (await res.json()) as RadarResponse;
  useRadar.setState((s) => {
    const events = { ...s.events };
    for (const e of body.events) events[e.id] ??= e;
    return {
      enabled: body.enabled,
      events,
      // Live pairs that arrived while loading are newer than the snapshot.
      pairs: s.pairs.length > 0 ? s.pairs : body.pairs,
    };
  });
}
