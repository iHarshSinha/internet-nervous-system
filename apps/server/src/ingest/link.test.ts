import type { EventEnvelope } from '@ins/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { IngestLink } from './link.ts';

const config = loadConfig({ NODE_ENV: 'test', MODE: 'replay' });
const log = createLogger(config);

const announce = (i: number, asn: number, now: number): EventEnvelope => ({
  v: 1,
  src: 'replay',
  eid: `replay:link-${i}`,
  kind: 'bgp.announce',
  ts: now,
  its: now,
  entity: { prefix: `10.${i}.0.0/16`, collector: 'rrc00', asn },
  data: { peer: '198.51.100.1', peerAsn: 3356, path: [3356, asn] },
});

/** Wait until `check` passes (state arrives four times a second). */
async function eventually(check: () => void | Promise<void>, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

let link: IngestLink | null = null;
afterEach(async () => {
  await link?.stop();
  link = null;
});

describe('IngestLink restarts', () => {
  it('starts a new ingest thread when the old one dies', async () => {
    link = new IngestLink({ config, log, thread: true });
    await link.replay.status();
    // Simulate a crash: kill the thread from outside.
    await (link as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    await eventually(() => expect(link!.thread().restarts).toBe(1));
    // Sent during the restart: held, then delivered to the new thread.
    const now = Date.now();
    link.ingest('replay', [announce(1, 64502, now)], now);
    await eventually(async () => expect(await link!.prefixesOf(64502, 5)).toEqual(['10.1.0.0/16']));
  });
});

// The same behaviour whether the ingest side runs in a worker thread or in this one.
describe.each([
  ['worker thread', true],
  ['same thread', false],
])('IngestLink (%s)', (_name, thread) => {
  it('pushes events through the pipeline and reports the counts back', async () => {
    link = new IngestLink({ config, log, thread });
    const now = Date.now();
    // One message per event: dedupe looks at the first event of a batch.
    for (let i = 0; i < 3; i++) link.ingest('replay', [announce(i, 64500, now)], now);

    // Events wait in the ingest queue until the next drain, so ask until they are in.
    await eventually(async () =>
      expect((await link!.prefixesOf(64500, 10)).sort()).toEqual([
        '10.0.0.0/16',
        '10.1.0.0/16',
        '10.2.0.0/16',
      ]),
    );
    await eventually(() => {
      expect(link!.stats.of('replay').events).toBe(3);
      expect(link!.pipelineSnapshot().knownPrefixes).toBe(3);
      expect(link!.thread().mode).toBe(thread ? 'worker' : 'inline');
      expect(link!.queue()).toMatchObject({ offered: 3, processed: 3, depth: 0, shedTotal: 0 });
    });
  });

  it('drops a duplicate sent twice', async () => {
    link = new IngestLink({ config, log, thread });
    const now = Date.now();
    link.ingest('replay', [announce(7, 64501, now)], now);
    link.ingest('replay', [announce(7, 64501, now)], now);
    await eventually(() => expect(link!.pipelineSnapshot().duplicates).toBe(1));
  });

  it('answers replay controls and network questions', async () => {
    link = new IngestLink({ config, log, thread });
    expect((await link.replay.status()).state).toBe('idle');
    expect(await link.largestIn('NL', 3)).toEqual([]);
  });
});
