import { beforeEach, describe, expect, it } from 'vitest';
import { onStatsFrame, resetOps, useOps } from './ops.ts';

describe('ops store', () => {
  beforeEach(resetOps);

  it('merges changed values and records one point per second', () => {
    onStatsFrame({
      r: 'stats',
      s: 1,
      t: 10_200,
      d: [
        ['in:ris', 'eps', 900],
        ['in:atlas', 'eps', 100],
        ['delay', 'p99', 3],
      ],
    });
    // Only the changed value arrives next; the rest is kept.
    onStatsFrame({ r: 'stats', s: 2, t: 11_300, d: [['in:ris', 'eps', 1100]] });
    const { now, points } = useOps.getState();
    expect(now['in:atlas']).toEqual({ eps: 100 });
    expect(points.get(10_000)).toMatchObject({ eps: 1000, delayP99: 3 });
    expect(points.get(11_000)).toMatchObject({ eps: 1200, delayP99: 3 });
  });
});
