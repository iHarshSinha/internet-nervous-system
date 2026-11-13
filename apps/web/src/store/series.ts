import { pointTime, type Frame, type HistoryResponse } from '@ins/shared';
import { create } from 'zustand';

/** One point of a chart. Routing and latency fields arrive separately and are merged. */
export interface Point {
  ann?: number;
  wd?: number;
  pfx?: number;
  p50?: number | null;
  p95?: number | null;
  pings?: number;
  up?: number;
}

export interface RoomSeries {
  /** 1-second points, keyed by window start (ms). */
  seconds: Map<number, Point>;
  /** 1-minute points, keyed by window start (ms). */
  minutes: Map<number, Point>;
  /** Current health from the live room. */
  health?: number;
  /** False until history has been merged in; frames are buffered meanwhile. */
  loaded: boolean;
  buffer: Frame[];
  /** Sequence numbers, for the on-screen proof that nothing was lost or doubled. */
  snapshotSeq: number | null;
  lastSeq: number | null;
  droppedBySnapshot: number;
}

const SECONDS_KEPT = 900; // 15 minutes
const MINUTES_KEPT_MS = 24 * 3600_000;

const rooms = new Map<string, RoomSeries>();

/** Bumped whenever any series changes; charts redraw at most once per animation frame. */
export const useSeries = create<{ version: number }>(() => ({ version: 0 }));
const bump = () => useSeries.setState((s) => ({ version: s.version + 1 }));

export function getSeries(room: string): RoomSeries | undefined {
  return rooms.get(room);
}

export function openSeries(room: string): RoomSeries {
  let s = rooms.get(room);
  if (!s) {
    s = {
      seconds: new Map(),
      minutes: new Map(),
      loaded: false,
      buffer: [],
      snapshotSeq: null,
      lastSeq: null,
      droppedBySnapshot: 0,
    };
    rooms.set(room, s);
  }
  return s;
}

export function closeSeries(room: string): void {
  rooms.delete(room);
  bump();
}

function merge(map: Map<number, Point>, t: number, value: Point): void {
  // Keyed by time: the same point arriving twice overwrites itself, never duplicates.
  map.set(t, { ...map.get(t), ...value });
}

function trim(s: RoomSeries): void {
  if (s.seconds.size > SECONDS_KEPT + 60) {
    const keys = [...s.seconds.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - SECONDS_KEPT)) s.seconds.delete(k);
  }
  const oldest = Date.now() - MINUTES_KEPT_MS;
  for (const k of s.minutes.keys()) if (k < oldest) s.minutes.delete(k);
}

function applyFrame(s: RoomSeries, frame: Frame): void {
  for (const [key, field, value] of frame.d) {
    if (key === 'now' && field === 'health' && typeof value === 'number') {
      s.health = value;
      continue;
    }
    const at = pointTime(key);
    if (!at || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    merge(at.res === 's' ? s.seconds : s.minutes, at.t, value as Point);
  }
  s.lastSeq = frame.s;
}

/** A live frame for a room (not `world`). Buffered until history is in. */
export function onRoomFrame(frame: Frame): void {
  const s = rooms.get(frame.r);
  if (!s) return;
  if (!s.loaded) {
    s.buffer.push(frame);
    return;
  }
  applyFrame(s, frame);
  trim(s);
  bump();
}

/**
 * The history half of the merge protocol (see CLAUDE.md "Contracts"):
 * history includes every frame up to `snapshotSeq`, so buffered frames up to
 * it are dropped and the rest are applied in order.
 */
export function loadHistory(res: HistoryResponse): void {
  const s = rooms.get(res.room);
  if (!s) return;
  for (const m of res.minutes) {
    merge(s.minutes, m.t, { ann: m.ann, wd: m.wd, pfx: m.pfx, p50: m.p50, p95: m.p95, up: m.up });
  }
  for (const p of res.seconds) merge(s.seconds, p.t, { ann: p.ann, wd: p.wd, pfx: p.pfx });

  s.snapshotSeq = res.snapshotSeq;
  for (const frame of s.buffer) {
    if (frame.s <= res.snapshotSeq) s.droppedBySnapshot += 1;
    else applyFrame(s, frame);
  }
  s.buffer = [];
  if (s.lastSeq === null || s.lastSeq < res.snapshotSeq) s.lastSeq = res.snapshotSeq;
  s.loaded = true;
  trim(s);
  bump();
}
