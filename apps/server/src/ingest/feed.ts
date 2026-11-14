import {
  feedRoomsFor,
  LIMITS,
  type EventEnvelope,
  type FeedBatch,
  type FeedEvent,
} from '@ins/shared';
import type { EventContext } from './pipeline/pipeline.ts';

/** Batches go out four times a second, so each holds a quarter of the per-second limit. */
export const FEED_EVERY_MS = 250;
const PER_BATCH = Math.max(1, Math.round((LIMITS.feedEventsPerSecond * FEED_EVERY_MS) / 1000));

/** The fields a list row needs, from the full envelope. */
export function toFeedEvent(e: EventEnvelope, ctx: EventContext): FeedEvent {
  const { entity, data } = e;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const out: FeedEvent = {
    id: e.eid,
    t: e.ts,
    k: e.kind,
    src: e.src,
    cc: ctx.cc ?? null,
    asn: ctx.asn ?? null,
  };
  const p = str(entity.prefix);
  if (p) out.p = p;
  const col = str(entity.collector);
  if (col) out.col = col;
  const peer = num(data.peerAsn);
  if (peer !== undefined) out.peer = peer;
  if (Array.isArray(data.path)) out.path = (data.path as number[]).slice(0, 64);
  const prb = num(entity.probeId);
  if (prb !== undefined) out.prb = prb;
  if (e.kind === 'atlas.ping') out.rtt = num(data.rtt) ?? null;
  const ev = str(data.event);
  if (ev) out.ev = ev;
  if (data.simulated === true) out.sim = true;
  return out;
}

/**
 * Picks the firehose samples, in the ingest thread.
 *
 * Only rooms someone is watching are considered (the main thread keeps
 * `watch()` up to date). For each, every matching event is counted, and a
 * fair random sample of at most PER_BATCH is kept per quarter second
 * (reservoir sampling: every event has the same chance, however many
 * arrive). `sample` is the ingest queue's 1-in-k, which thins the feed
 * further while the pipeline is under pressure.
 */
export class FeedSampler {
  private watched = new Set<string>();
  private readonly rooms = new Map<string, { n: number; seen: number; keep: FeedEvent[] }>();
  private readonly random: () => number;
  /** Events the 1-in-k pressure sampling left out of the feed. */
  sampledOut = 0;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  /** The feed rooms that have at least one member. */
  watch(rooms: string[]): void {
    this.watched = new Set(rooms);
    for (const room of this.rooms.keys()) if (!this.watched.has(room)) this.rooms.delete(room);
  }

  get active(): boolean {
    return this.watched.size > 0;
  }

  offer(e: EventEnvelope, ctx: EventContext, sample: () => boolean): void {
    if (this.watched.size === 0) return;
    const matched = feedRoomsFor(e.kind, ctx.cc ?? null).filter((r) => this.watched.has(r));
    if (matched.length === 0) return;
    // Counted before sampling: `n` is how many events the room really had.
    for (const room of matched) this.slot(room).n += 1;
    if (!sample()) {
      this.sampledOut += 1;
      return;
    }
    let row: FeedEvent | null = null;
    for (const room of matched) {
      const s = this.slot(room);
      s.seen += 1;
      if (s.keep.length < PER_BATCH) {
        s.keep.push((row ??= toFeedEvent(e, ctx)));
      } else {
        const j = Math.floor(this.random() * s.seen);
        if (j < PER_BATCH) s.keep[j] = row ??= toFeedEvent(e, ctx);
      }
    }
  }

  /** The batches of this interval (rooms with events only), then start a new interval. */
  take(): FeedBatch[] {
    const out: FeedBatch[] = [];
    for (const [r, s] of this.rooms) {
      if (s.n > 0) out.push({ r, n: s.n, e: s.keep.sort((a, b) => a.t - b.t) });
    }
    this.rooms.clear();
    return out;
  }

  private slot(room: string) {
    let s = this.rooms.get(room);
    if (!s) {
      s = { n: 0, seen: 0, keep: [] };
      this.rooms.set(room, s);
    }
    return s;
  }
}
