import { rooms } from '@ins/shared';
import { create } from 'zustand';
import type { LinkStats, LinkStatus, WorkerUpdate } from '../workers/socket.worker.ts';

interface LiveState {
  status: LinkStatus;
  stats: LinkStats;
  /** Heartbeat counter from the server. */
  tick: number;
  /** Browsers connected to the server; null until the server has told us. */
  sockets: number | null;
  /** Sequence number and server time of the latest `world` frame. */
  seq: number;
  serverTime: number | null;
  /**
   * Milliseconds between the server stamping the latest frame and this page
   * applying it. It includes any difference between the two clocks; Phase 3
   * adds a clock-offset estimate to correct for that.
   */
  delayMs: number | null;

  /** Apply one batched update from the socket worker. One call, one render. */
  apply(update: WorkerUpdate): void;
}

export const useLive = create<LiveState>((set) => ({
  status: 'connecting',
  stats: { received: 0, duplicates: 0, gaps: 0 },
  tick: 0,
  sockets: null,
  seq: 0,
  serverTime: null,
  delayMs: null,

  apply: (update) =>
    set((state) => {
      const next: Partial<LiveState> = { status: update.status, stats: update.stats };

      for (const frame of update.frames) {
        if (frame.r !== rooms.world) continue;
        next.seq = frame.s;
        next.serverTime = frame.t;
        next.delayMs = Date.now() - frame.t;
        // Deltas: only fields that changed are present, so merge, never replace.
        for (const [key, field, value] of frame.d) {
          if (key !== 'sys' || typeof value !== 'number') continue;
          if (field === 'tick') next.tick = value;
          else if (field === 'sockets') next.sockets = value;
        }
      }
      return { ...state, ...next };
    }),
}));
