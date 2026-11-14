import { rooms, type Incident, type IncidentsResponse } from '@ins/shared';
import { Router } from 'express';
import type { IncidentStore } from '../db/incidents.ts';
import type { RoomSequencer } from '../realtime/sequencer.ts';

export interface IncidentsDeps {
  /** The live incidents (open, resolving, recently resolved). */
  manager: { active(): Incident[]; get(id: string): Incident | undefined };
  store: IncidentStore;
  seq: RoomSequencer;
}

/**
 * GET /api/incidents: the open ones first (from memory, exactly what the
 * incidents room is describing), then those of the last day from MongoDB.
 * GET /api/incidents/:id: one incident.
 */
export function incidentsRouter({ manager, store, seq }: IncidentsDeps): Router {
  const router = Router();

  router.get('/api/incidents', async (_req, res) => {
    const recent = await store.recent(50, Date.now() - 24 * 3600_000);
    // Read the live ones and the sequence number together, after the await.
    const active = manager.active();
    const snapshotSeq = seq.current(rooms.incidents);
    const seen = new Set(active.map((i) => i.id));
    const incidents: Incident[] = [...active, ...recent.filter((i) => !seen.has(i.id))].slice(
      0,
      50,
    );
    const body: IncidentsResponse = { snapshotSeq, incidents };
    res.set('Cache-Control', 'no-store').json(body);
  });

  router.get('/api/incidents/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      res.status(400).json({ error: { code: 'bad_request', message: 'Invalid incident ID' } });
      return;
    }
    const incident = manager.get(id) ?? (await store.get(id));
    if (!incident) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such incident' } });
      return;
    }
    res.set('Cache-Control', 'no-store').json(incident);
  });

  return router;
}
