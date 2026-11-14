import type { FeedBatch, FeedEvent } from '@ins/shared';
import { create } from 'zustand';

/** Rows kept for the list; older ones fall off the end. */
const KEEP = 500;

interface FeedState {
  /** Newest first. A sample of the room's events, not all of them. */
  events: FeedEvent[];
  /** How many events the room really had per second (before sampling), smoothed. */
  perSecond: number;
  /** Events received in this page, and events the room had in the same time. */
  shown: number;
  total: number;
  /** Batches that arrived in the worker's last update are appended here. */
  apply(batches: FeedBatch[]): void;
  clear(): void;
}

/**
 * The firehose: samples of raw events from the one feed room this page
 * watches. Batches arrive four times a second; `n` is how many events the
 * room had in that quarter second, so the rate shown is real even though
 * only a few rows are.
 */
export const useFeed = create<FeedState>((set) => ({
  events: [],
  perSecond: 0,
  shown: 0,
  total: 0,
  apply: (batches) =>
    set((s) => {
      if (batches.length === 0) return s;
      const rows = batches.flatMap((b) => b.e).reverse();
      const n = batches.reduce((sum, b) => sum + b.n, 0);
      // Each batch covers a quarter second: n * 4 is that moment's rate.
      const rate = (n * 4) / batches.length;
      return {
        events: [...rows, ...s.events].slice(0, KEEP),
        perSecond: s.perSecond === 0 ? rate : s.perSecond * 0.8 + rate * 0.2,
        shown: s.shown + rows.length,
        total: s.total + n,
      };
    }),
  clear: () => set({ events: [], perSecond: 0, shown: 0, total: 0 }),
}));
