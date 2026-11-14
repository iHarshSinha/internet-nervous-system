import type { Frame } from '@ins/shared';
import { describe, expect, it } from 'vitest';
import { RoomSync } from './roomSync.ts';

const f = (s: number): Frame => ({ r: 'country:IN', s, t: 1794565823000 + s, d: [] });
const seqs = (frames: Frame[]) => frames.map((frame) => frame.s);

describe('RoomSync', () => {
  it('applies frames that follow on from the acknowledged sequence', () => {
    const sync = new RoomSync();
    sync.start(10);
    expect(seqs(sync.receive(f(11)).apply)).toEqual([11]);
    expect(seqs(sync.receive(f(12)).apply)).toEqual([12]);
    expect(sync.lastApplied).toBe(12);
  });

  it('holds frames that arrive before the acknowledgement', () => {
    const sync = new RoomSync();
    expect(sync.receive(f(5)).apply).toEqual([]);
    expect(seqs(sync.start(4).apply)).toEqual([5]);
  });

  it('accepts a slow-client summary covering several frames as the next step', () => {
    const sync = new RoomSync();
    sync.start(10);
    const summary: Frame = { ...f(14), f: 11 };
    expect(seqs(sync.receive(summary).apply)).toEqual([14]);
    expect(seqs(sync.receive(f(15)).apply)).toEqual([15]);
    expect(sync.stats.gaps).toBe(0);
  });

  it('drops duplicates', () => {
    const sync = new RoomSync();
    sync.start(0);
    sync.receive(f(1));
    expect(sync.receive(f(1)).apply).toEqual([]);
    expect(sync.stats.duplicates).toBe(1);
  });

  it('asks for a resync on a gap and applies everything in order afterwards', () => {
    const sync = new RoomSync();
    sync.start(0);
    sync.receive(f(1));

    const gap = sync.receive(f(4));
    expect(gap).toEqual({ apply: [], resyncAfter: 1 });
    // More frames arrive while the resync is in flight: held, not applied.
    expect(sync.receive(f(5)).apply).toEqual([]);

    const done = sync.resynced([f(2), f(3), f(4)]);
    expect(seqs(done.apply)).toEqual([2, 3, 4, 5]);
    expect(done.resyncAfter).toBeUndefined();
    expect(sync.stats).toMatchObject({ gaps: 1, resyncs: 1, applied: 5 });
  });

  it('continues and asks for a history reload when the missing frames are gone', () => {
    const sync = new RoomSync();
    sync.start(0);
    sync.receive(f(1));
    sync.receive(f(200));
    sync.receive(f(201));
    const result = sync.resynced(null);
    expect(result.stale).toBe(true);
    expect(seqs(result.apply)).toEqual([200, 201]);
    expect(sync.stats.tooOld).toBe(1);
  });

  it('merges with a history snapshot: frames already in it are dropped', () => {
    const sync = new RoomSync();
    sync.start(40); // joined at 40
    // Frames 41..43 arrive and are applied while history is loading...
    for (const s of [41, 42, 43]) sync.receive(f(s));
    // ...history says it already includes everything up to 42.
    sync.snapshot(42);
    expect(sync.lastApplied).toBe(43);
    expect(sync.receive(f(43)).apply).toEqual([]);
    expect(seqs(sync.receive(f(44)).apply)).toEqual([44]);
  });

  it('jumps forward to a snapshot that is ahead of the stream', () => {
    const sync = new RoomSync();
    sync.start(10);
    sync.snapshot(15);
    expect(sync.receive(f(14)).apply).toEqual([]);
    expect(seqs(sync.receive(f(16)).apply)).toEqual([16]);
  });

  it('gives up waiting for a resync that never answers, instead of holding frames forever', () => {
    const sync = new RoomSync();
    sync.start(0);
    sync.receive(f(1));
    sync.receive(f(3)); // gap: waiting for frame 2
    let sawStale = false;
    for (let s = 4; s <= 210; s++) {
      const result = sync.receive(f(s)); // always call it; `||=` would skip it once true
      if (result.stale) sawStale = true;
    }
    expect(sawStale).toBe(true); // the caller is told to reload history
    expect(sync.stats.tooOld).toBe(1);
    expect(sync.lastApplied).toBe(210); // and the stream carries on
  });
});
