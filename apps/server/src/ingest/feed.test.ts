import type { EventEnvelope } from '@ins/shared';
import { describe, expect, it } from 'vitest';
import { FeedSampler, toFeedEvent } from './feed.ts';
import type { EventContext } from './pipeline/pipeline.ts';

const ctx = (cc: string | undefined, asn?: number): EventContext => ({
  asn,
  cc,
  prevOrigin: undefined,
  masked: false,
});
let n = 0;
const announce = (): EventEnvelope => ({
  v: 1,
  src: 'ris',
  eid: `ris:f-${n++}`,
  kind: 'bgp.announce',
  ts: 1000 + n,
  its: 1000 + n,
  entity: { prefix: '10.0.0.0/8', collector: 'rrc00', asn: 64500 },
  data: { peerAsn: 3356, path: [3356, 64500] },
});
const always = () => true;

describe('FeedSampler', () => {
  it('ignores events while nobody watches a matching room', () => {
    const f = new FeedSampler();
    f.offer(announce(), ctx('NL', 64500), always);
    f.watch(['feed:bgp.withdraw:*', 'feed:*:DE']);
    f.offer(announce(), ctx('NL', 64500), always);
    expect(f.take()).toEqual([]);
  });

  it('counts every match but keeps at most 5 per quarter second, per room', () => {
    const f = new FeedSampler(() => 0.99); // never replace a kept event
    f.watch(['feed:bgp.announce:NL', 'feed:*:*']);
    for (let i = 0; i < 40; i++) f.offer(announce(), ctx('NL', 64500), always);
    const batches = f.take();
    expect(batches.map((b) => [b.r, b.n, b.e.length]).sort()).toEqual([
      ['feed:*:*', 40, 5],
      ['feed:bgp.announce:NL', 40, 5],
    ]);
    expect(f.take()).toEqual([]); // a new interval starts empty
  });

  it('gives every event the same chance (reservoir), not just the first ones', () => {
    // With random() = 0 every new event replaces slot 0, so the last one ends up kept.
    const f = new FeedSampler(() => 0);
    f.watch(['feed:*:*']);
    const events = Array.from({ length: 20 }, announce);
    for (const e of events) f.offer(e, ctx('NL'), always);
    expect(f.take()[0]!.e.map((e) => e.id)).toContain(events.at(-1)!.eid);
  });

  it('thins the feed with the queue sampling, but still counts everything', () => {
    const f = new FeedSampler();
    f.watch(['feed:*:*']);
    let i = 0;
    const oneInFour = () => i++ % 4 === 0;
    for (let k = 0; k < 8; k++) f.offer(announce(), ctx('NL'), oneInFour);
    const [batch] = f.take();
    expect(batch).toMatchObject({ n: 8 });
    expect(batch!.e).toHaveLength(2);
    expect(f.sampledOut).toBe(6);
  });

  it('flattens an event to what a list row needs', () => {
    const e = announce();
    expect(toFeedEvent(e, ctx('NL', 64500))).toEqual({
      id: e.eid,
      t: e.ts,
      k: 'bgp.announce',
      src: 'ris',
      cc: 'NL',
      asn: 64500,
      p: '10.0.0.0/8',
      col: 'rrc00',
      peer: 3356,
      path: [3356, 64500],
    });
  });
});
