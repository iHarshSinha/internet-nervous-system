import { rooms, type ReplayStatus, type ScenarioStatus } from '@ins/shared';
import { create } from 'zustand';
import { applyWorldFrame } from './globe.ts';
import { onRoomFrame } from './series.ts';
import type { LinkStats, LinkStatus, UserChannel, WorkerUpdate } from '../workers/socket.worker.ts';

/** Live numbers for one upstream source (ris, atlas, ...). */
export interface SourceLive {
  /** Events per second over the last second. */
  eps: number;
  /** Mean age, in seconds, of events when they reached the server. */
  lag: number | null;
  /** Messages rejected by validation since the server started. */
  rejected: number;
}

interface LiveState {
  status: LinkStatus;
  /** The personal `/user` channel. */
  userChannel: UserChannel;
  stats: LinkStats;
  /** Heartbeat counter from the server. */
  tick: number;
  /** Browsers connected to the server; null until the server has told us. */
  sockets: number | null;
  /** Upstream connections: how many exist and how many are up. */
  upstreams: number | null;
  upstreamsUp: number | null;
  sources: Record<string, SourceLive>;
  /** Latest closed windows for the whole world, and pipeline counters. */
  world: Record<string, number>;
  pipe: Record<string, number>;
  /** What the replay is doing (everyone sees it, so recorded data is never taken for live). */
  replay: Pick<ReplayStatus, 'state' | 'scenario' | 'speed' | 'clock'>;
  /** An admin-triggered scenario, if one is running (everyone sees it). */
  scenario: Pick<ScenarioStatus, 'state' | 'id' | 'startedAt' | 'durationMs' | 'phase'>;
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
  userChannel: 'off',
  stats: { received: 0, duplicates: 0, gaps: 0, resyncs: 0, tooOld: 0 },
  tick: 0,
  sockets: null,
  upstreams: null,
  upstreamsUp: null,
  sources: {},
  world: {},
  pipe: {},
  replay: { state: 'idle', scenario: null, speed: 1, clock: null },
  scenario: { state: 'idle', id: null, startedAt: null, durationMs: 0, phase: null },
  seq: 0,
  serverTime: null,
  delayMs: null,

  apply: (update) =>
    set((state) => {
      const next: Partial<LiveState> = {
        status: update.status,
        userChannel: update.user,
        stats: update.stats,
      };

      for (const frame of update.frames) {
        // Personal alerts (Phase 2) arrive in user:<id>; nothing renders them yet.
        if (frame.r.startsWith('user:')) continue;
        // Other rooms feed the charts; the world room feeds the globe and the readouts.
        if (frame.r !== rooms.world) {
          onRoomFrame(frame);
          continue;
        }
        applyWorldFrame(frame);
        next.seq = frame.s;
        next.serverTime = frame.t;
        next.delayMs = Date.now() - frame.t;
        // Deltas: only fields that changed are present, so merge, never replace.
        for (const [key, field, value] of frame.d) {
          if (key === 'scenario') {
            next.scenario = { ...(next.scenario ?? state.scenario), [field]: value };
            continue;
          }
          if (key === 'replay') {
            next.replay = { ...(next.replay ?? state.replay), [field]: value };
            continue;
          }
          if (typeof value !== 'number') continue;
          if (key === 'sys') {
            if (field === 'tick') next.tick = value;
            else if (field === 'sockets') next.sockets = value;
            else if (field === 'upstreams') next.upstreams = value;
            else if (field === 'upstreamsUp') next.upstreamsUp = value;
          } else if (key === 'world' || key === 'pipe') {
            const group = (next[key] ??= { ...state[key] });
            group[field] = value;
          } else if (key.startsWith('src:')) {
            // Copy before changing, so components comparing by reference notice.
            const name = key.slice(4);
            const sources = (next.sources ??= { ...state.sources });
            const current = sources[name] ?? { eps: 0, lag: null, rejected: 0 };
            if (field === 'eps' || field === 'lag' || field === 'rejected') {
              sources[name] = { ...current, [field]: value };
            }
          }
        }
      }
      return { ...state, ...next };
    }),
}));
