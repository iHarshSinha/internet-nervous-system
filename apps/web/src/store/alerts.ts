import type { Frame, Incident } from '@ins/shared';
import { create } from 'zustand';
import { merge } from './incidents.ts';

/*
 * Personal alerts. The server sends them over the private `/user` channel to
 * people whose watchlist covers the incident's country or network, at or
 * above their chosen severity. Here they only mark an incident as "yours";
 * the alert card itself is drawn from the shared incident data.
 */

interface AlertsState {
  /** Incident id -> when the personal alert arrived. */
  mine: Record<string, number>;
}

export const useAlerts = create<AlertsState>(() => ({ mine: {} }));

export function onUserFrame(frame: Frame): void {
  const list: Incident[] = [];
  for (const [key, field, value] of frame.d) {
    if (key.startsWith('alert:') && field === 'v' && value && typeof value === 'object') {
      list.push(value as unknown as Incident);
    }
  }
  if (list.length === 0) return;
  // The alert may arrive before the same change in the public room.
  merge(list, true);
  const ids = list.map((i) => i.id);
  useAlerts.setState((s) => {
    const mine = { ...s.mine };
    for (const id of ids) mine[id] ??= Date.now();
    return { mine };
  });
}
