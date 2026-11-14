import type { FeedEvent } from '@ins/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFeed } from './feed.ts';

const ev = (id: string, t: number): FeedEvent => ({
  id,
  t,
  k: 'bgp.withdraw',
  src: 'ris',
  cc: 'DE',
  asn: null,
});

describe('feed store', () => {
  beforeEach(() => useFeed.getState().clear());

  it('puts the newest rows first and keeps the real event rate', () => {
    useFeed.getState().apply([{ r: 'feed:*:*', n: 100, e: [ev('a', 1), ev('b', 2)] }]);
    useFeed.getState().apply([{ r: 'feed:*:*', n: 50, e: [ev('c', 3)] }]);
    const s = useFeed.getState();
    expect(s.events.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(s.total).toBe(150); // events the room had
    expect(s.shown).toBe(3); // rows we got
    expect(s.perSecond).toBeCloseTo(400 * 0.8 + 200 * 0.2); // 100 then 50 per quarter second
  });

  it('keeps at most 500 rows', () => {
    const batch = Array.from({ length: 600 }, (_, i) => ev(String(i), i));
    useFeed.getState().apply([{ r: 'feed:*:*', n: 600, e: batch }]);
    expect(useFeed.getState().events).toHaveLength(500);
    expect(useFeed.getState().events[0]!.id).toBe('599');
  });
});
