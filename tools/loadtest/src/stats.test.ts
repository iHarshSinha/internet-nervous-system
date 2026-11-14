import { describe, expect, it } from 'vitest';
import { Distribution, SeqChecker } from './stats.ts';

describe('Distribution', () => {
  it('reports percentiles, mean and max', () => {
    const d = new Distribution();
    for (let v = 1; v <= 1000; v++) d.add(v);
    expect(d.summary()).toEqual({ n: 1000, mean: 500.5, p50: 501, p95: 951, p99: 991, max: 1000 });
  });

  it('keeps a fair sample once past its cap, and still counts everything', () => {
    const d = new Distribution(100);
    for (let v = 0; v < 100_000; v++) d.add(v);
    const s = d.summary();
    expect(s.n).toBe(100_000);
    expect(s.max).toBe(99_999);
    expect(s.p50).toBeGreaterThan(20_000); // not just the first 100 values
    expect(s.p50).toBeLessThan(80_000);
  });

  it('is all zeros when empty', () => {
    expect(new Distribution().summary()).toEqual({ n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });
});

describe('SeqChecker', () => {
  const f = (r: string, s: number, from?: number) => ({
    r,
    s,
    t: 0,
    d: [],
    ...(from && { f: from }),
  });

  it('counts gaps and duplicates per room, from the acknowledged start', () => {
    const c = new SeqChecker();
    c.start({ world: 10, 'country:IN': 0 });
    c.check(f('world', 11));
    c.check(f('world', 11)); // duplicate
    c.check(f('world', 13)); // 12 is missing
    c.check(f('country:IN', 1));
    c.check(f('country:IN', 4, 2)); // a slow-client summary covering 2..4: fine
    c.check(f('asn:1', 1)); // not ours: ignored
    expect(c).toMatchObject({ frames: 5, gaps: 1, duplicates: 1 });
  });
});
