import { describe, expect, it } from 'vitest';
import { healthScore } from './index.ts';

describe('healthScore', () => {
  it('is 100 for normal live traffic (about 5% withdrawals, no lost pings)', () => {
    expect(healthScore({ ann: 2070, wd: 104, pings: 300, lost: 0 })).toBe(100);
  });

  it('is 100 when there is too little data to judge', () => {
    expect(healthScore({ ann: 0, wd: 19, pings: 4, lost: 4 })).toBe(100);
  });

  it('falls as the share of withdrawals rises', () => {
    expect(healthScore({ ann: 75, wd: 25, pings: 0, lost: 0 })).toBe(100); // 25%
    expect(healthScore({ ann: 50, wd: 50, pings: 0, lost: 0 })).toBe(50); // 50%
    expect(healthScore({ ann: 0, wd: 400, pings: 0, lost: 0 })).toBe(0); // a network vanishing
  });

  it('falls as pings go unanswered', () => {
    expect(healthScore({ ann: 0, wd: 0, pings: 100, lost: 5 })).toBe(100);
    expect(healthScore({ ann: 0, wd: 0, pings: 100, lost: 50 })).toBe(0);
  });

  it('takes the worse of the two signals', () => {
    expect(healthScore({ ann: 50, wd: 50, pings: 100, lost: 5 })).toBe(50);
    expect(healthScore({ ann: 95, wd: 5, pings: 100, lost: 50 })).toBe(0);
  });
});

describe('latencyBucket', async () => {
  const { latencyBucket, LOST_BUCKET } = await import('./index.ts');
  it('maps round-trip times to colour buckets', () => {
    expect([5, 20, 49.9, 99, 150, 900].map(latencyBucket)).toEqual([0, 1, 1, 2, 3, 4]);
    expect(latencyBucket(null)).toBe(LOST_BUCKET);
  });
});
