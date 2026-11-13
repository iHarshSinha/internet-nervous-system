import type { Frame, Incident, IncidentsResponse } from '@ins/shared';
import { create } from 'zustand';

/*
 * Incidents, live. The `incidents` room carries one delta per change:
 * ["inc:<id>", "v", <the whole incident>]. Each incident has `updatedAt`, so
 * merging is simple and safe: keep whichever copy is newer. That makes the
 * history load and the live frames commutative: whatever order they arrive
 * in, and however often, the result is the same (no duplicates, no going back).
 */

interface IncidentsState {
  byId: Record<string, Incident>;
  /** Incidents that opened while this page was open, newest first (for alerts). */
  fresh: string[];
  /** History loaded (so alerts are not raised for incidents that were already open). */
  loaded: boolean;
}

export const useIncidents = create<IncidentsState>(() => ({ byId: {}, fresh: [], loaded: false }));

export function merge(list: Incident[], live: boolean): void {
  useIncidents.setState((state) => {
    let byId = state.byId;
    let fresh = state.fresh;
    for (const incident of list) {
      const known = byId[incident.id];
      if (known && known.updatedAt >= incident.updatedAt) continue;
      if (byId === state.byId) byId = { ...byId };
      byId[incident.id] = incident;
      // A new incident, seen live after the page loaded: raise an alert.
      if (!known && live && state.loaded && incident.state !== 'resolved') {
        fresh = [incident.id, ...fresh.filter((id) => id !== incident.id)].slice(0, 5);
      }
    }
    // Keep the last 24 hours at most.
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [id, i] of Object.entries(byId)) {
      if (i.state === 'resolved' && (i.resolvedAt ?? 0) < cutoff) {
        if (byId === state.byId) byId = { ...byId };
        delete byId[id];
      }
    }
    return byId === state.byId && fresh === state.fresh ? state : { byId, fresh };
  });
}

/** Apply one frame from the incidents room. */
export function onIncidentFrame(frame: Frame): void {
  const list: Incident[] = [];
  for (const [key, field, value] of frame.d) {
    if (key.startsWith('inc:') && field === 'v' && value && typeof value === 'object') {
      list.push(value as unknown as Incident);
    }
  }
  if (list.length > 0) merge(list, true);
}

/** Load open and recent incidents once the room is joined. */
export async function loadIncidents(): Promise<void> {
  try {
    const res = await fetch('/api/incidents');
    if (!res.ok) return;
    const body = (await res.json()) as IncidentsResponse;
    merge(body.incidents, false);
  } finally {
    useIncidents.setState({ loaded: true });
  }
}

export function dismissAlert(id: string): void {
  useIncidents.setState((s) => ({ fresh: s.fresh.filter((x) => x !== id) }));
}

/** Open and resolving incidents, worst first, then newest. */
export function activeIncidents(byId: Record<string, Incident>): Incident[] {
  const rank = { critical: 0, warning: 1, watch: 2 } as const;
  return Object.values(byId)
    .filter((i) => i.state !== 'resolved')
    .sort(
      (a, b) =>
        (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
        rank[a.severity] - rank[b.severity] ||
        b.openedAt - a.openedAt,
    );
}

/** The incident's headline subject: "Facebook, Inc. (AS32934)", "AS64512" or a country. */
export function incidentTitle(i: Incident, countryName: (cc: string) => string): string {
  if (i.asn !== null) return i.name ? `${i.name}` : `AS${i.asn}`;
  return i.cc ? countryName(i.cc) : 'Unknown';
}
