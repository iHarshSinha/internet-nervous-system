import {
  eventEnvelopeSchema,
  SIMULATED_HIJACKER,
  type EventEnvelope,
  type Incident,
} from '@ins/shared';
import { describe, expect, it } from 'vitest';
import { Detectors } from '../ingest/detect/detectors.ts';
import { IncidentManager } from '../ingest/detect/incidents.ts';
import { Pipeline } from '../ingest/pipeline/pipeline.ts';
import { AttackError, attackPlan, type AttackDeps } from './attacks.ts';
import type { ScenarioPlan } from './runner.ts';

const T0 = Date.UTC(2026, 10, 13, 12, 0);
const VICTIM = 64500;
const CC = 'NL';
const PROBES = Array.from({ length: 40 }, (_, i) => 1000 + i);

/**
 * A small world: one network in NL with 60 prefixes, 40 probes in NL, an hour
 * of quiet history. Then a plan is played through the real pipeline,
 * detectors and incident manager on a simulated clock, exactly as the
 * scenario runner would (stamped now, marked simulated).
 */
function world() {
  const pipeline = new Pipeline({
    lookup: {
      asnCountry: (asn) => (asn === VICTIM ? CC : undefined),
      probe: (id) => (PROBES.includes(id) ? { id, cc: CC, status: 'Connected' } : undefined),
    },
    onEvent: (e, ctx) => detectors.observe(e, ctx, e.ts),
    onSecond: () => {},
    onMinute: (w) => w.family === 'bgp' && detectors.onMinute(w.scopes),
  });
  const detectors = new Detectors({
    origins: pipeline.origins,
    connectedProbes: () => PROBES.length,
  });
  const prefixes = Array.from({ length: 60 }, (_, i) => `10.${i}.0.0/16`);
  prefixes.forEach((prefix, i) =>
    pipeline.ingest(
      [
        {
          v: 1,
          src: 'ris',
          eid: `ris:seed-${i}`,
          kind: 'bgp.announce',
          ts: T0 - 60_000,
          its: T0 - 60_000,
          entity: { prefix, collector: 'rrc00', asn: VICTIM },
          data: { peer: '198.51.100.1', peerAsn: 3356, path: [3356, VICTIM] },
        },
      ],
      T0 - 60_000,
    ),
  );
  // An hour of quiet minutes we were watching.
  const covered = Array.from({ length: 60 }, (_, i) => T0 - (60 - i) * 60_000);
  detectors.warmStart(
    covered,
    new Map([
      [`asn:${VICTIM}`, new Map()],
      [`country:${CC}`, new Map()],
    ]),
  );

  const deps: AttackDeps = {
    prefixesOf: (asn, limit) => pipeline.origins.prefixesOf(asn, limit),
    largestIn: (cc, n) => pipeline.origins.largest(n, (asn) => asn === VICTIM && cc === CC),
    probesIn: (cc) => (cc === CC ? PROBES : []),
    countryOf: (asn) => (asn === VICTIM ? CC : undefined),
  };

  const changes: Incident[] = [];
  const manager = new IncidentManager({
    nameOf: () => 'Example Net',
    countryOf: (asn) => (asn === VICTIM ? CC : undefined),
    onChange: (i) => changes.push(structuredClone(i)),
  });

  /** Play a plan; returns every event as the runner would send it. */
  function play(plan: ScenarioPlan): EventEnvelope[] {
    const sent: EventEnvelope[] = [];
    let next = 0;
    for (let elapsed = 0; elapsed <= plan.durationMs + 60_000; elapsed += 250) {
      const now = T0 + elapsed;
      while (next < plan.steps.length && plan.steps[next]!.at <= elapsed) {
        const step = plan.steps[next++]!;
        const batch = step.batch.map((e) => ({
          ...e,
          eid: `replay:s1:${e.eid.replace(/^replay:/, '')}`,
          ts: now,
          its: now,
          data: { ...e.data, simulated: true, scenario: plan.id },
        }));
        sent.push(...batch);
        pipeline.ingest(batch, now);
      }
      if (elapsed % 1000 === 0) {
        manager.report(detectors.evaluate(now), now);
        manager.tick(now);
      }
    }
    return sent;
  }
  return { deps, play, changes };
}

const opened = (changes: Incident[], scope: string) => changes.filter((i) => i.scope === scope);

describe('attack simulator', () => {
  it('outage: a critical incident for the network, which resolves after the recovery', async () => {
    const { deps, play, changes } = world();
    const plan = await attackPlan('outage', { asn: VICTIM }, deps);
    expect(plan.masked).toEqual([VICTIM]);
    const sent = play(plan);
    for (const e of sent) expect(eventEnvelopeSchema.safeParse(e).success).toBe(true);
    const mine = opened(changes, `asn:${VICTIM}`);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.at(-1)).toMatchObject({ severity: 'critical', state: 'resolved', simulated: true });
    expect(new Set(mine.flatMap((i) => i.signals.map((s) => s.type)))).toEqual(
      new Set(['withdrawal_storm', 'network_vanished']),
    );
  });

  it('hijack: a possible-hijack incident naming the simulated attacker', async () => {
    const { deps, play, changes } = world();
    play(await attackPlan('hijack', { asn: VICTIM }, deps));
    const last = opened(changes, `asn:${VICTIM}`).at(-1);
    expect(last?.signals[0]).toMatchObject({
      type: 'origin_change',
      detail: expect.objectContaining({ hijacker: SIMULATED_HIJACKER }),
    });
    expect(last?.severity).toBe('warning');
  });

  it('latency and dropout: each opens a country incident on its own', async () => {
    for (const id of ['latency', 'dropout'] as const) {
      const { deps, play, changes } = world();
      play(await attackPlan(id, { cc: CC }, deps));
      const last = opened(changes, `country:${CC}`).at(-1);
      expect(last?.signals.map((s) => s.type)).toEqual([
        id === 'latency' ? 'latency_surge' : 'probe_dropout',
      ]);
      expect(last?.state).toBe('resolved');
    }
  });

  it('blackout: critical incidents for the country and its network', async () => {
    const { deps, play, changes } = world();
    play(await attackPlan('blackout', { cc: CC }, deps));
    expect(opened(changes, `country:${CC}`).at(-1)?.severity).toBe('critical');
    expect(opened(changes, `asn:${VICTIM}`).at(-1)?.severity).toBe('critical');
  });

  it('refuses targets it cannot attack believably', async () => {
    const { deps } = world();
    await expect(attackPlan('outage', { asn: 65000 }, deps)).rejects.toThrow(AttackError);
    await expect(attackPlan('latency', { cc: 'FR' }, deps)).rejects.toThrow(AttackError);
    await expect(attackPlan('outage', {}, deps)).rejects.toThrow(/Pick a network/);
  });

  it("fetches a network's prefixes when the live table does not know it yet, and announces them first", async () => {
    const { deps, play, changes } = world();
    const other = Array.from({ length: 30 }, (_, i) => `172.16.${i}.0/24`);
    const plan = await attackPlan(
      'outage',
      { asn: 65010 },
      {
        ...deps,
        countryOf: () => CC,
        fetchPrefixes: async (asn) => (asn === 65010 ? other : []),
      },
    );
    expect(plan.steps[0]!.batch[0]).toMatchObject({ kind: 'bgp.announce', entity: { asn: 65010 } });
    play(plan);
    expect(opened(changes, 'asn:65010').at(-1)?.severity).toBe('critical');
  });
});
