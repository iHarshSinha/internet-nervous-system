import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { SCENARIOS, type EventEnvelope } from '@ins/shared';
import type { ScenarioPlan, ScenarioStep } from './runner.ts';

const OUTAGE_FROM = Date.UTC(2021, 9, 4, 15, 39);
const OUTAGE_TO = Date.UTC(2021, 9, 4, 15, 54);

/** 15 recorded minutes in 90 seconds. */
const SPEED = 10;
const PRIME_MS = 2000;
const OUTAGE_AT = 3000;
const QUIET_MS = 15_000;
const RECOVERY_MS = 8000;

/** "replay:rrc05-x-12#3" -> "replay:rrc05-x-12": the events of one original message. */
function messageOf(eid: string): string {
  const hash = eid.lastIndexOf('#');
  return hash > 0 ? eid.slice(0, hash) : eid;
}

/** Group consecutive events of the same message into one step at the given offset. */
function group(
  events: EventEnvelope[],
  at: (e: EventEnvelope, i: number) => number,
): ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  let current: ScenarioStep | null = null;
  let message = '';
  events.forEach((e, i) => {
    const m = messageOf(e.eid);
    if (!current || m !== message) {
      current = { at: Math.round(at(e, i)), batch: [] };
      steps.push(current);
      message = m;
    }
    current.batch.push(e);
  });
  return steps;
}

/**
 * The Facebook outage as a two-minute scenario:
 *
 *   0-2 s     prime     real announcements of Facebook's prefixes from just before
 *                       the outage, so the pipeline knows who owns them
 *   3-93 s    outage    every real Facebook announcement and withdrawal from
 *                       15:39 to 15:54 UTC, played 10x faster
 *   93-108 s  quiet     nothing: Facebook is gone
 *   108-116 s recovery  SIMULATED: each prefix announced again, so the network
 *                       comes back (in 2021 that took about six hours)
 */
export function facebookPlan(file: string): ScenarioPlan {
  const lines = gunzipSync(readFileSync(file)).toString('utf8').trim().split('\n');
  const events = lines.map((line) => JSON.parse(line) as EventEnvelope);
  const prime = events.filter((e) => e.data.part === 'prime');
  const outage = events.filter((e) => e.data.part === 'outage');

  // For the recovery, re-announce the last known announcement of every prefix.
  const lastAnnounce = new Map<string, EventEnvelope>();
  for (const e of [...prime, ...outage]) {
    if (e.kind === 'bgp.announce' && e.entity.prefix) lastAnnounce.set(e.entity.prefix, e);
  }
  const recoveryAt = OUTAGE_AT + (OUTAGE_TO - OUTAGE_FROM) / SPEED + QUIET_MS;
  const recovery = [...lastAnnounce.values()].map((e, i): EventEnvelope => ({
    ...e,
    eid: `replay:recover-${i}`,
    data: { ...e.data, part: 'recovery', synthetic: true },
  }));

  const steps = [
    ...group(prime, (_e, i) => (i / Math.max(1, prime.length)) * PRIME_MS),
    ...group(outage, (e) => OUTAGE_AT + (e.ts - OUTAGE_FROM) / SPEED),
    ...group(recovery, (_e, i) => recoveryAt + (i / Math.max(1, recovery.length)) * RECOVERY_MS),
  ].sort((a, b) => a.at - b.at);

  return {
    id: 'facebook-2021',
    asn: FACEBOOK.asn,
    cc: FACEBOOK.cc,
    target: `AS${FACEBOOK.asn}`,
    masked: [FACEBOOK.asn],
    steps,
    durationMs: recoveryAt + RECOVERY_MS + 2000,
    phases: [
      { name: 'priming', at: 0 },
      { name: 'outage', at: OUTAGE_AT },
      { name: 'gone', at: OUTAGE_AT + (OUTAGE_TO - OUTAGE_FROM) / SPEED },
      { name: 'recovery', at: recoveryAt },
    ],
  };
}

export const FACEBOOK = SCENARIOS['facebook-2021'];
