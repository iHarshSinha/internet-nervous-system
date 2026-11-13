import type { Frame, HistoryResponse } from '@ins/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeSeries, getSeries, loadHistory, onRoomFrame, openSeries } from './series.ts';

const ROOM = 'country:IN';
const T = Date.now() - 120_000;
const second = (s: number, t: number, ann: number): Frame => ({
  r: ROOM,
  s,
  t: Date.now(),
  d: [[`s:${t}`, 'bgp', { ann, wd: 1, pfx: 1 }]],
});
const history = (snapshotSeq: number, seconds: [number, number][]): HistoryResponse => ({
  scope: 'country',
  key: 'IN',
  room: ROOM,
  snapshotSeq,
  serverTime: Date.now(),
  minutes: [],
  seconds: seconds.map(([t, ann]) => ({
    t,
    ann,
    wd: 1,
    pfx: 1,
    p50: null,
    p95: null,
    up: 0,
    down: 0,
    health: 100,
    late: 0,
  })),
});

describe('history and live merge', () => {
  beforeEach(() => {
    closeSeries(ROOM);
    openSeries(ROOM);
  });

  it('buffers live frames until history arrives, then drops those history already has', () => {
    // Joined at seq 10; frames 11-13 arrive while history is loading.
    onRoomFrame(second(11, T, 5));
    onRoomFrame(second(12, T + 1000, 6));
    onRoomFrame(second(13, T + 2000, 7));
    expect(getSeries(ROOM)!.seconds.size).toBe(0);

    // History was read at seq 12: it includes the points of frames 11 and 12.
    loadHistory(
      history(12, [
        [T - 1000, 4],
        [T, 5],
        [T + 1000, 6],
      ]),
    );
    const s = getSeries(ROOM)!;
    expect(
      [...s.seconds.entries()].sort(([a], [b]) => a - b).map(([t, p]) => [t - T, p.ann]),
    ).toEqual([
      [-1000, 4],
      [0, 5],
      [1000, 6],
      [2000, 7],
    ]);
    expect(s).toMatchObject({ snapshotSeq: 12, lastSeq: 13, droppedBySnapshot: 2, loaded: true });
  });

  it('cannot create a duplicate point even if the same window arrives twice', () => {
    loadHistory(history(0, [[T, 5]]));
    onRoomFrame(second(1, T, 5));
    onRoomFrame(second(2, T, 5));
    expect(getSeries(ROOM)!.seconds.size).toBe(1);
  });

  it('merges routing and latency minutes that arrive separately', () => {
    loadHistory(history(0, []));
    onRoomFrame({ r: ROOM, s: 1, t: 0, d: [[`m:${T}`, 'bgp', { ann: 100, wd: 3, pfx: 2 }]] });
    onRoomFrame({
      r: ROOM,
      s: 2,
      t: 0,
      d: [[`m:${T}`, 'lat', { p50: 30, p95: 80, pings: 9, lost: 0, up: 7, down: 0 }]],
    });
    expect(getSeries(ROOM)!.minutes.get(T)).toMatchObject({ ann: 100, p50: 30, up: 7 });
  });

  it('ignores frames for rooms that are not open', () => {
    closeSeries(ROOM);
    onRoomFrame(second(1, T, 5));
    expect(getSeries(ROOM)).toBeUndefined();
  });
});
