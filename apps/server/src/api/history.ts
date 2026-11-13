import {
  healthScore,
  historyQuerySchema,
  roomForScope,
  type HistoryResponse,
  type MetricPoint,
} from '@ins/shared';
import { Router } from 'express';
import { RETENTION_MS, type MetricsStore, type MinuteRow } from '../db/metrics.ts';
import type { RecentSeconds } from '../ingest/recent.ts';
import type { RoomSequencer } from '../realtime/sequencer.ts';

export interface HistoryDeps {
  store: Pick<MetricsStore, 'readMinutes'>;
  recent: RecentSeconds;
  seq: RoomSequencer;
}

function toPoint({ t, slot }: MinuteRow): MetricPoint {
  const ann = slot.ann ?? 0;
  const wd = slot.wd ?? 0;
  const pings = slot.pings ?? 0;
  const lost = slot.lost ?? 0;
  return {
    t,
    ann,
    wd,
    pfx: slot.pfx ?? 0,
    p50: slot.p50 ?? null,
    p95: slot.p95 ?? null,
    up: slot.up ?? 0,
    down: slot.down ?? 0,
    health: healthScore({ ann, wd, pings, lost }),
    late: 0,
  };
}

/**
 * GET /api/history?scope=country&key=IN&from=<ms>[&to=<ms>]
 *
 * Returns 1-minute points from MongoDB, 1-second points for the last 15
 * minutes from memory, and `snapshotSeq`: the room's sequence number at the
 * moment the in-memory points were read. The client drops live frames up to
 * and including that number and applies the rest, so history and live data
 * join with no gap and no duplicate.
 */
export function historyRouter({ store, recent, seq }: HistoryDeps): Router {
  const router = Router();

  router.get('/api/history', async (req, res) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'bad_request',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }

    const { scope } = parsed.data;
    const key = scope === 'world' ? '' : parsed.data.key;
    const now = Date.now();
    // Never ask for more than the database keeps.
    const from = Math.max(parsed.data.from, now - RETENTION_MS[scope]);
    const to = Math.min(parsed.data.to ?? now, now);
    const room = roomForScope(scope, key);

    const minutes = (await store.readMinutes(scope, key, from, to)).map(toPoint);

    // Read the in-memory points and the sequence number together, with no
    // `await` in between, so no live frame can slip between the two.
    const seconds = recent.get(room, from).filter((p) => p.t < to);
    const snapshotSeq = seq.current(room);

    const body: HistoryResponse = {
      scope,
      key,
      room,
      snapshotSeq,
      serverTime: now,
      minutes,
      seconds,
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  return router;
}
