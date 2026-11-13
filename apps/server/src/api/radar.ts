import { rooms, type AttackPair, type RadarResponse } from '@ins/shared';
import { Router } from 'express';
import type { RadarStore } from '../db/radar.ts';
import type { RoomSequencer } from '../realtime/sequencer.ts';

export interface RadarDeps {
  enabled: boolean;
  store: RadarStore;
  pairs(): { pairs: AttackPair[]; updatedAt: number | null };
  seq: RoomSequencer;
}

/**
 * GET /api/radar: Cloudflare Radar events of the last 3 days (and ongoing ones)
 * plus the latest attack pairs, with the `arcs` room's sequence number so the
 * client can merge live updates without duplicates.
 */
export function radarRouter({ enabled, store, pairs, seq }: RadarDeps): Router {
  const router = Router();
  router.get('/api/radar', async (_req, res) => {
    const events = enabled ? await store.recent(Date.now() - 3 * 24 * 3600_000, 60) : [];
    const current = pairs();
    const body: RadarResponse = {
      enabled,
      snapshotSeq: seq.current(rooms.arcs),
      updatedAt: current.updatedAt,
      events,
      pairs: current.pairs,
    };
    res.set('Cache-Control', 'no-store').json(body);
  });
  return router;
}
