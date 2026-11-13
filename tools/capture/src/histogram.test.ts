import { describe, expect, it } from 'vitest';
import { LogHistogram } from './histogram.ts';

describe('LogHistogram', () => {
  it('is empty at first', () => {
    const h = new LogHistogram();
    expect(h.count).toBe(0);
    expect(h.percentile(0.5)).toBeNull();
  });

  it('estimates percentiles to within about 10%', () => {
    const h = new LogHistogram();
    for (let ms = 1; ms <= 10_000; ms++) h.add(ms);
    expect(h.count).toBe(10_000);
    expect(h.max).toBe(10_000);
    for (const [p, exact] of [
      [0.5, 5000],
      [0.95, 9500],
      [0.99, 9900],
    ] as const) {
      const got = h.percentile(p)!;
      expect(Math.abs(got - exact) / exact).toBeLessThan(0.11);
    }
  });

  it('never reports more than the largest sample, and clamps tiny values', () => {
    const h = new LogHistogram();
    h.add(0);
    h.add(0.2);
    h.add(42);
    expect(h.percentile(1)).toBe(42);
    expect(h.percentile(0.5)).toBeLessThanOrEqual(2);
  });
});
