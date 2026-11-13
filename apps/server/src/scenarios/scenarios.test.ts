import { fileURLToPath } from 'node:url';
import { eventEnvelopeSchema, type EventEnvelope } from '@ins/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { facebookPlan } from './facebook.ts';
import { ScenarioRunner, type ScenarioPlan } from './runner.ts';
import { createMemoryRunsStore } from './runs.ts';

const FILE = fileURLToPath(
  new URL('../../../../deploy/seed/scenarios/facebook-2021.ndjson.gz', import.meta.url),
);
const log = pino({ level: 'silent' });

describe('the Facebook scenario plan (committed recording)', () => {
  const plan = facebookPlan(FILE);
  const events = plan.steps.flatMap((s) => s.batch);
  const part = (name: string) => events.filter((e) => e.data.part === name);

  it('primes, plays the real outage 10x faster, then recovers, in about two minutes', () => {
    expect(plan.phases.map((p) => p.name)).toEqual(['priming', 'outage', 'gone', 'recovery']);
    expect(plan.durationMs).toBeGreaterThan(100_000);
    expect(plan.durationMs).toBeLessThan(150_000);
    expect(part('prime').length).toBeGreaterThan(50);
    expect(part('outage').filter((e) => e.kind === 'bgp.withdraw').length).toBeGreaterThan(2000);
    // Steps are in time order and the outage fits its 90-second slot.
    const ats = plan.steps.map((s) => s.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    const outageAts = plan.steps.filter((s) => s.batch[0]!.data.part === 'outage').map((s) => s.at);
    expect(Math.min(...outageAts)).toBeGreaterThanOrEqual(3000);
    expect(Math.max(...outageAts)).toBeLessThanOrEqual(93_000);
  });

  it('marks the recovery as synthetic and keeps every event valid', () => {
    const recovery = part('recovery');
    expect(recovery.length).toBeGreaterThan(50);
    expect(recovery.every((e) => e.data.synthetic === true && e.kind === 'bgp.announce')).toBe(
      true,
    );
    for (const e of events.slice(0, 500))
      expect(eventEnvelopeSchema.safeParse(e).success).toBe(true);
    expect(events.every((e) => e.entity.asn === undefined || e.entity.asn === 32934)).toBe(true);
  });
});

describe('ScenarioRunner', () => {
  const event = (n: number): EventEnvelope => ({
    v: 1,
    src: 'replay',
    eid: `replay:test-${n}#0`,
    kind: 'bgp.withdraw',
    ts: 1633362000000 + n,
    its: 1633362000000 + n,
    entity: { prefix: `10.0.${n}.0/24`, collector: 'rrc10' },
    data: {},
  });
  const plan: ScenarioPlan = {
    id: 'facebook-2021',
    steps: [0, 40, 80].map((at, n) => ({ at, batch: [event(n)] })),
    durationMs: 120,
    phases: [
      { name: 'a', at: 0 },
      { name: 'b', at: 60 },
    ],
  };

  it('stamps events now, labels them simulated, gives fresh IDs per run, and records the run', async () => {
    const got: EventEnvelope[] = [];
    const runs = createMemoryRunsStore();
    const started: number[] = [];
    const ended: number[] = [];
    const runner = new ScenarioRunner({
      log,
      sink: (batch) => got.push(...batch),
      onStart: (run, _plan, at) => {
        started.push(run);
        void runs.started('facebook-2021', at, 32934, 'US');
      },
      onEnd: (run) => ended.push(run),
    });
    const before = Date.now();
    runner.start(plan);
    expect(runner.snapshot()).toMatchObject({ state: 'running', id: 'facebook-2021', phase: 'a' });
    await new Promise((r) => setTimeout(r, 250));

    expect(got).toHaveLength(3);
    expect(got[0]).toMatchObject({
      eid: 'replay:s1:test-0#0',
      data: { simulated: true, scenario: 'facebook-2021', origTs: 1633362000000 },
    });
    expect(got.every((e) => e.ts >= before && e.ts <= Date.now())).toBe(true);
    expect(runner.snapshot().state).toBe('idle');
    expect(started).toEqual([1]);
    expect(ended).toEqual([1]);
    expect(await runs.between(before - 1, Date.now() + 1)).toHaveLength(1);

    runner.start(plan);
    runner.stop();
    expect(got.at(-1)!.eid).toBe('replay:s2:test-0#0'); // the second run's first event, fresh ID
  });
});
