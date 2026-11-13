import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { eventEnvelopeSchema, type EventEnvelope } from '@ins/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { ReplayPlayer } from './replay.ts';

const T0 = Date.UTC(2021, 9, 4, 15, 30);
const log = pino({ level: 'silent' });

/** A tiny recording: 10 messages one second apart, two prefixes each. */
function recording(): string {
  const lines: string[] = [];
  for (let m = 0; m < 10; m++) {
    for (let part = 0; part < 2; part++) {
      lines.push(
        JSON.stringify({
          v: 1,
          src: 'replay',
          eid: `replay:rrc10-202110041530-${m}#${part}`,
          kind: 'bgp.withdraw',
          ts: T0 + m * 1000,
          its: T0 + m * 1000,
          entity: { prefix: `10.${m}.${part}.0/24`, collector: 'rrc10' },
          data: { peerAsn: 3356 },
        }),
      );
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'ins-replay-'));
  const file = join(dir, 'test.ndjson.gz');
  writeFileSync(file, gzipSync(lines.join('\n') + '\n'));
  return file;
}

function player(file: string) {
  const batches: EventEnvelope[][] = [];
  const p = new ReplayPlayer({
    files: { 'facebook-2021': file },
    log,
    sink: (batch) => batches.push(batch),
  });
  return { p, batches };
}

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe('ReplayPlayer', () => {
  it('plays every event, retimed to now, one message per batch', async () => {
    const { p, batches } = player(recording());
    const started = Date.now();
    p.start('facebook-2021', 50, T0); // 9 s of recording at 50x: about 180 ms
    await until(() => p.snapshot().state === 'finished');

    expect(batches).toHaveLength(10);
    expect(batches.every((b) => b.length === 2)).toBe(true);
    const events = batches.flat();
    for (const e of events) expect(eventEnvelopeSchema.safeParse(e).success).toBe(true);
    // Stamped near now, in order, spaced 1 s / 50 = 20 ms apart, original time kept.
    expect(events[0]!.ts).toBeGreaterThanOrEqual(started - 5);
    expect(events.at(-1)!.ts - events[0]!.ts).toBe(180);
    expect(events.at(-1)!.data.origTs).toBe(T0 + 9000);
    expect(events[0]!.eid).toBe('replay:r1:rrc10-202110041530-0#0');
    expect(p.snapshot()).toMatchObject({ emitted: 20, clock: T0 + 9000, run: 1 });
  });

  it('gives each run fresh event IDs, so a second run is not a duplicate of the first', async () => {
    const { p, batches } = player(recording());
    p.start('facebook-2021', 50, T0);
    await until(() => p.snapshot().state === 'finished');
    p.start('facebook-2021', 50, T0);
    await until(() => p.snapshot().state === 'finished' && batches.length === 20);
    expect(batches[10]![0]!.eid).toBe('replay:r2:rrc10-202110041530-0#0');
  });

  it('starts from a chosen original time', async () => {
    const { p, batches } = player(recording());
    p.start('facebook-2021', 50, T0 + 7000);
    await until(() => p.snapshot().state === 'finished');
    expect(batches.map((b) => b[0]!.data.origTs)).toEqual([T0 + 7000, T0 + 8000, T0 + 9000]);
  });

  it('pauses without losing events, and resumes', async () => {
    const { p, batches } = player(recording());
    p.start('facebook-2021', 5, T0); // 200 ms between messages
    await until(() => batches.length >= 2);
    p.pause();
    const atPause = batches.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(batches.length).toBeLessThanOrEqual(atPause + 1); // at most the one already due
    p.setSpeed(50);
    p.resume();
    await until(() => p.snapshot().state === 'finished');
    expect(batches.flat()).toHaveLength(20);
  });

  it('stops, and reports a missing file instead of crashing', async () => {
    const { p, batches } = player(recording());
    p.start('facebook-2021', 1, T0);
    await until(() => batches.length >= 1);
    p.stop();
    await new Promise((r) => setTimeout(r, 1200));
    expect(batches.length).toBeLessThanOrEqual(2);
    expect(p.snapshot().state).toBe('idle');

    const missing = new ReplayPlayer({
      files: { 'facebook-2021': '/nope.gz' },
      log,
      sink: () => {},
    });
    missing.start('facebook-2021', 10, T0);
    expect(missing.snapshot()).toMatchObject({ state: 'error' });
    expect(missing.snapshot().error).toMatch(/pnpm replay-prep/);
  });
});
