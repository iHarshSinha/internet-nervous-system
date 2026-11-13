import { latencyBucket, rooms, type CountriesResponse, type ProbesResponse } from '@ins/shared';
import { Router } from 'express';
import type { Pipeline } from '../ingest/pipeline/pipeline.ts';
import type { Publisher } from '../realtime/publish.ts';
import type { RoomSequencer } from '../realtime/sequencer.ts';

export interface GlobeDeps {
  /** Probe locations. Empty until the reference data has loaded. */
  probes: () => Iterable<{ id: number; lat?: number; lon?: number; cc?: string; status: string }>;
  pipeline: Pipeline;
  publisher: Publisher;
  seq: RoomSequencer;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Snapshots for the globe: where every probe is and its latest latency
 * bucket, and every country's current health. Both carry the world room's
 * sequence number, so the client knows which live deltas are newer.
 */
export function globeRouter({ probes, pipeline, publisher, seq }: GlobeDeps): Router {
  const router = Router();

  router.get('/api/probes', (_req, res) => {
    const rows: ProbesResponse['probes'] = [];
    for (const p of probes()) {
      if (p.lat === undefined || p.lon === undefined || p.status !== 'Connected') continue;
      const latest = pipeline.probeLatest.get(p.id);
      rows.push([
        p.id,
        round2(p.lat),
        round2(p.lon),
        p.cc ?? '',
        latest ? latencyBucket(latest.rtt) : -1,
      ]);
    }
    const body: ProbesResponse = { snapshotSeq: seq.current(rooms.world), probes: rows };
    res.set('Cache-Control', 'no-store').json(body);
  });

  router.get('/api/countries', (_req, res) => {
    const body: CountriesResponse = {
      snapshotSeq: seq.current(rooms.world),
      countries: publisher.countries(),
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  return router;
}
