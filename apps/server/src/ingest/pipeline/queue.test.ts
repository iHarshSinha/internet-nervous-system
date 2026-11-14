import type { EventEnvelope, EventKind } from '@ins/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestQueue } from './queue.ts';

let n = 0;
const ev = (kind: EventKind): EventEnvelope => ({
  v: 1,
  src: 'ris',
  eid: `ris:q-${n++}`,
  kind,
  ts: 1,
  its: 1,
  entity: {},
  data: {},
});
const many = (kind: EventKind, count: number) => Array.from({ length: count }, () => ev(kind));
/** Let the queue's setImmediate drain run. */
const drained = () => new Promise((r) => setImmediate(r));

let queue: IngestQueue | null = null;
afterEach(() => {
  queue?.stop();
  queue = null;
  vi.useRealTimers();
});

function make(capacity: number) {
  const seen: EventEnvelope[] = [];
  queue = new IngestQueue({ capacity, process: (b) => seen.push(...b) });
  return { q: queue, seen };
}

/*
 * Offers made one after another, with no await in between, all land before
 * the first drain runs, so the queue can be filled to any level on purpose.
 */
describe('IngestQueue', () => {
  it('passes everything through, in order, when there is room', async () => {
    const { q, seen } = make(100);
    const a = many('bgp.announce', 3);
    const b = many('bgp.withdraw', 2);
    q.offer(a);
    q.offer(b);
    expect(q.depth).toBe(5);
    await drained();
    expect(seen).toEqual([...a, ...b]);
    expect(q.snapshot()).toMatchObject({ depth: 0, offered: 5, processed: 5, shedTotal: 0 });
  });

  it('samples, but keeps everything, between 70% and 95%', () => {
    const { q } = make(100);
    q.offer(many('bgp.withdraw', 80));
    expect(q.pressure()).toBe('sampling');
    q.offer(many('bgp.announce', 5));
    expect(q.depth).toBe(85);
    expect(q.snapshot().shedTotal).toBe(0);
  });

  it('sheds announcements first, from 95%', async () => {
    const { q, seen } = make(100);
    q.offer(many('bgp.withdraw', 96));
    expect(q.pressure()).toBe('shedding');
    const kept = [ev('bgp.withdraw'), ev('atlas.ping')];
    q.offer([ev('bgp.announce'), kept[0]!, ev('bgp.announce'), kept[1]!]);
    expect(q.snapshot()).toMatchObject({ depth: 98, shedTotal: 2, shed: { 'bgp.announce': 2 } });
    await drained();
    expect(seen.slice(-2)).toEqual(kept);
  });

  it('lets only withdrawals and probe status into the reserve above 100%', () => {
    const { q } = make(100);
    q.offer(many('bgp.withdraw', 100));
    expect(q.pressure()).toBe('reserve');
    q.offer([ev('bgp.announce'), ev('atlas.ping'), ev('bgp.withdraw'), ev('atlas.probe_status')]);
    expect(q.depth).toBe(102);
    expect(q.snapshot().shed).toEqual({ 'bgp.announce': 1, 'atlas.ping': 1 });
  });

  it('refuses everything at the hard limit (120%) and counts it as overflow', () => {
    const { q } = make(100);
    q.offer(many('bgp.withdraw', 120));
    expect(q.pressure()).toBe('full');
    q.offer([ev('bgp.withdraw'), ev('atlas.probe_status')]);
    expect(q.snapshot()).toMatchObject({ depth: 120, overflow: 2, shedTotal: 0 });
  });

  it('makes a file source wait instead of dropping, until the queue is half empty', async () => {
    const { q, seen } = make(10);
    expect(q.offerAndWait(many('bgp.announce', 5))).toBeUndefined(); // 50%: no wait yet
    const wait = q.offerAndWait(many('bgp.announce', 3)); // 80%: wait
    expect(wait).toBeInstanceOf(Promise);
    await wait; // resolves once the drain has emptied it
    expect(seen).toHaveLength(8);
    expect(q.snapshot()).toMatchObject({ pauses: 1, shedTotal: 0, overflow: 0 });
  });

  it('thins the raw feed to 1 in k while under pressure, and recovers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const { q } = make(10);
    expect(Array.from({ length: 4 }, () => q.sample())).toEqual([true, true, true, true]);

    q.offer(many('bgp.withdraw', 8)); // 80%
    vi.advanceTimersByTime(1000);
    expect(q.snapshot().sampleEvery).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(q.snapshot().sampleEvery).toBe(4);
    const picks = Array.from({ length: 8 }, () => q.sample()).filter(Boolean);
    expect(picks).toHaveLength(2);

    await drained(); // pressure gone
    vi.advanceTimersByTime(2000);
    expect(q.snapshot().sampleEvery).toBe(1);
  });
});
