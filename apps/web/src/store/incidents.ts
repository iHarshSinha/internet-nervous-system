import type { Frame, Incident, IncidentsResponse } from '@ins/shared';
import { create } from 'zustand';
import { countryName } from '../geo.ts';
import { wire } from './wire.ts';

/** Opening, worsening and recovery go on the wire, in a few words. */
function toWire(i: Incident, before: Incident | undefined): void {
  const who = incidentTitle(i, countryName);
  const href = `/incident/${i.id}`;
  const sim = i.simulated ? ' (simulated)' : '';
  if (!before && i.state !== 'resolved') {
    wire({
      id: `${i.id}:open`,
      text: `${who}: ${i.severity} incident opened${sim}`,
      tone: i.severity === 'critical' ? 'critical' : 'warning',
      href,
    });
  } else if (before && before.severity !== 'critical' && i.severity === 'critical') {
    wire({ id: `${i.id}:critical`, text: `${who} is now critical${sim}`, tone: 'critical', href });
  } else if (before && before.state !== 'resolved' && i.state === 'resolved') {
    wire({ id: `${i.id}:resolved`, text: `${who} recovered`, tone: 'calm', href });
  }
}

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
      if (live && state.loaded) toWire(incident, known);
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
/** The last hour's openings and recoveries, so the wire is not empty when the page opens. */
function seedWire(list: Incident[]): void {
  const since = Date.now() - 3600_000;
  const events: { at: number; i: Incident; kind: 'open' | 'resolved' }[] = [];
  for (const i of list) {
    if (i.openedAt >= since) events.push({ at: i.openedAt, i, kind: 'open' });
    if (i.resolvedAt !== null && i.resolvedAt >= since)
      events.push({ at: i.resolvedAt, i, kind: 'resolved' });
  }
  // Oldest first: each one is put in front, so the newest ends up first.
  for (const { at, i, kind } of events.sort((a, b) => a.at - b.at)) {
    const who = incidentTitle(i, countryName);
    wire({
      id: `${i.id}:${kind}`,
      at,
      text:
        kind === 'open'
          ? `${who}: ${i.severity} incident opened${i.simulated ? ' (simulated)' : ''}`
          : `${who} recovered`,
      tone: kind === 'resolved' ? 'calm' : i.severity === 'critical' ? 'critical' : 'warning',
      href: `/incident/${i.id}`,
    });
  }
}

export async function loadIncidents(): Promise<void> {
  try {
    const res = await fetch('/api/incidents');
    if (!res.ok) return;
    const body = (await res.json()) as IncidentsResponse;
    merge(body.incidents, false);
    seedWire(body.incidents);
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
