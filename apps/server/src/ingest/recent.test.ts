import { describe, expect, it } from 'vitest';
import { finalise, newAgg } from './pipeline/aggregate.ts';
import type { WindowResult } from './pipeline/pipeline.ts';
import { RecentSeconds } from './recent.ts';

const second = (start: number, wd: number, amended = false): WindowResult => {
  const agg = newAgg();
  agg.wd = wd;
  return {
    family: 'bgp',
    start,
    sizeMs: 1000,
    scopes: new Map([['world', finalise(agg)]]),
    amended,
  };
};

describe('RecentSeconds', () => {
  it('replaces a corrected second and slots in one that closed empty, in time order', () => {
    const r = new RecentSeconds();
    r.add(second(1000, 1));
    r.add(second(3000, 1));
    r.add(second(1000, 5, true)); // a correction
    r.add(second(2000, 2, true)); // a second that closed with nothing in it
    expect(r.get('world', 0).map((p) => [p.t, p.wd])).toEqual([
      [1000, 5],
      [2000, 2],
      [3000, 1],
    ]);
  });
});
