import type { Frame } from '@ins/shared';
import { describe, expect, it } from 'vitest';
import type { WorkerUpdate } from '../workers/socket.worker.ts';
import { mergeUpdates } from './merge.ts';

const frame = (r: string, s: number): Frame => ({ r, s, t: s, d: [] });
const stats = (received: number) => ({ received, duplicates: 0, gaps: 0, resyncs: 0, tooOld: 0 });
const update = (
  frames: Frame[],
  received: number,
  status: WorkerUpdate['status'] = 'live',
): WorkerUpdate => ({
  status,
  user: 'off',
  frames,
  feed: [],
  stats: stats(received),
});

describe('mergeUpdates', () => {
  it('keeps every frame in arrival order and the newest status and counters', () => {
    const merged = mergeUpdates([
      update([frame('world', 1), frame('country:IN', 7)], 2, 'reconnecting'),
      update([], 2, 'live'),
      update([frame('world', 2)], 3, 'live'),
    ]);
    expect(merged?.frames.map((f) => `${f.r}#${f.s}`)).toEqual([
      'world#1',
      'country:IN#7',
      'world#2',
    ]);
    expect(merged?.status).toBe('live');
    expect(merged?.stats.received).toBe(3);
  });

  it('returns null for nothing', () => {
    expect(mergeUpdates([])).toBeNull();
  });
});
