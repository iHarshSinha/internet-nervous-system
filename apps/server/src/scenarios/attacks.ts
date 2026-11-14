import {
  ENVELOPE_VERSION,
  SIMULATED_HIJACKER,
  type EventEnvelope,
  type EventKind,
  type ScenarioId,
} from '@ins/shared';
import type { ScenarioPlan, ScenarioStep } from './runner.ts';

/*
 * Synthetic attacks for demonstrations. They are built from the live state at
 * the moment the admin presses the button (the target's real prefixes and
 * real probes), so the detectors see exactly what a real attack would look
 * like, then everything is put back. The runner stamps every event with the
 * current time and `simulated: true`.
 */

export interface AttackDeps {
  /** Prefixes the network currently announces (from the live routing table, on the ingest side). */
  prefixesOf(asn: number, limit: number): string[] | Promise<string[]>;
  /** The country's networks with the most prefixes. */
  largestIn(cc: string, n: number): number[] | Promise<number[]>;
  /** The country's connected RIPE Atlas probes. */
  probesIn(cc: string): number[];
  countryOf(asn: number): string | undefined;
  /**
   * The network's announced prefixes from RIPEstat, for when our live table
   * (built only from updates since the server started) does not know enough yet.
   */
  fetchPrefixes?(asn: number): Promise<string[]>;
}

/** Real prefixes of the network, and whether they must be announced first (fetched, not live). */
async function prefixesFor(
  deps: AttackDeps,
  asn: number,
  min: number,
  limit: number,
): Promise<{ prefixes: string[]; prime: boolean }> {
  const live = await deps.prefixesOf(asn, limit);
  if (live.length >= min || !deps.fetchPrefixes) return { prefixes: live, prime: false };
  const fetched = (await deps.fetchPrefixes(asn).catch(() => [])).slice(0, limit);
  return fetched.length > live.length
    ? { prefixes: fetched, prime: true }
    : { prefixes: live, prime: false };
}

/** Announce prefixes from a few routers so the live table knows who owns them. */
function primeSteps(s: Steps, asn: number, prefixes: string[]) {
  for (let p = 0; p < 3; p++) {
    const { collector, peer, peerAsn } = peerOf(p);
    prefixes.forEach((prefix, i) =>
      s.add(
        p * 400 + (i % 10) * 40,
        'bgp.announce',
        { prefix, collector, asn },
        { peer, peerAsn, path: [peerAsn, 3356, asn], pathLen: 3 },
      ),
    );
  }
}

export class AttackError extends Error {}

/** Collectors and routers the simulated updates appear to come from. */
const COLLECTORS = ['rrc00', 'rrc01', 'rrc03', 'rrc10', 'rrc11', 'rrc12', 'rrc14', 'rrc21'];
const PEERS = 40;
const peerOf = (i: number) => ({
  collector: COLLECTORS[i % COLLECTORS.length]!,
  peer: `192.0.2.${i + 1}`, // TEST-NET-1: addresses reserved for examples
  peerAsn: 64496 + (i % 15), // ASNs reserved for examples
});

/** Builds steps; event IDs only need to be unique within a run. */
class Steps {
  readonly steps: ScenarioStep[] = [];
  private n = 0;
  add(at: number, kind: EventKind, entity: EventEnvelope['entity'], data: EventEnvelope['data']) {
    const event: EventEnvelope = {
      v: ENVELOPE_VERSION,
      src: 'replay',
      eid: `replay:atk-${this.n++}`,
      kind,
      ts: 0,
      its: 0,
      entity,
      data,
    };
    const last = this.steps.at(-1);
    // Events at the same moment travel as one message, like a real upstream message.
    if (last && last.at === at && last.batch.length < 200) last.batch.push(event);
    else this.steps.push({ at: Math.round(at), batch: [event] });
  }
  sorted(): ScenarioStep[] {
    return this.steps.sort((a, b) => a.at - b.at);
  }
}

/**
 * Every router withdraws every route to the network over ~30 s (a storm),
 * the network stays unreachable, then it is announced again.
 */
function outageSteps(s: Steps, asn: number, prefixes: string[], from: number, recoverAt: number) {
  for (let p = 0; p < PEERS; p++) {
    const { collector, peer, peerAsn } = peerOf(p);
    const at = from + p * 750;
    for (const prefix of prefixes) {
      s.add(at, 'bgp.withdraw', { prefix, collector }, { peer, peerAsn });
    }
  }
  // Recovery: three routers per prefix see it announced again by its owner.
  for (let p = 0; p < 3; p++) {
    const { collector, peer, peerAsn } = peerOf(p);
    prefixes.forEach((prefix, i) =>
      s.add(
        recoverAt + p * 1500 + (i % 10) * 100,
        'bgp.announce',
        { prefix, collector, asn },
        { peer, peerAsn, path: [peerAsn, 3356, asn], pathLen: 3 },
      ),
    );
  }
}

/** Slow or lost pings from the country's probes, after a few normal ones (their usual latency). */
function latencySteps(s: Steps, probes: number[], from: number, until: number) {
  // Every target the probes measure (the built-in pings to three root servers) slows down.
  const ping = (at: number, probeId: number, rtt: number | null) => {
    for (const msmId of [1001, 1008, 1006]) {
      s.add(at, 'atlas.ping', { probeId, msmId }, { rtt, sent: 3, rcvd: rtt === null ? 0 : 3 });
    }
  };
  probes.forEach((id, i) => {
    const usual = 15 + ((id * 7) % 40);
    for (let k = 0; k < 4; k++) ping(k * 500 + (i % 20) * 20, id, usual + k);
    for (let at = from; at < until; at += 5000) {
      const lost = (id + at / 5000) % 3 === 0;
      ping(at + (i % 25) * 40, id, lost ? null : 300 + ((id * 13 + at) % 600));
    }
    // Back to normal.
    ping(until + 500 + (i % 25) * 40, id, usual);
    ping(until + 4000 + (i % 25) * 40, id, usual);
  });
}

/** Half of the country's probes disconnect, then reconnect. */
function dropoutSteps(s: Steps, probes: number[], from: number, reconnectAt: number) {
  const gone = probes.slice(0, Math.max(5, Math.ceil(probes.length * 0.5)));
  gone.forEach((probeId, i) => {
    s.add(from + i * 120, 'atlas.probe_status', { probeId }, { event: 'disconnect' });
    s.add(reconnectAt + i * 60, 'atlas.probe_status', { probeId }, { event: 'connect' });
  });
}

export async function attackPlan(
  id: Exclude<ScenarioId, 'facebook-2021'>,
  target: { asn?: number | undefined; cc?: string | undefined },
  deps: AttackDeps,
): Promise<ScenarioPlan> {
  const s = new Steps();
  const base = { id, steps: s.steps };

  if (id === 'outage' || id === 'hijack') {
    if (target.asn === undefined) throw new AttackError('Pick a network (ASN) to target');
    const asn = target.asn;
    const min = id === 'outage' ? 20 : 3;
    const { prefixes, prime } = await prefixesFor(deps, asn, min, id === 'outage' ? 300 : 12);
    if (prime) primeSteps(s, asn, prefixes);
    if (prefixes.length < min) {
      throw new AttackError(
        `AS${asn} announces only ${prefixes.length} address blocks; pick a bigger network`,
      );
    }
    const cc = deps.countryOf(asn) ?? null;
    if (id === 'outage') {
      outageSteps(s, asn, prefixes, 2000, 75_000);
      return {
        ...base,
        steps: s.sorted(),
        durationMs: 85_000,
        phases: [
          { name: 'outage', at: 0 },
          { name: 'gone', at: 32_000 },
          { name: 'recovery', at: 75_000 },
        ],
        asn,
        cc,
        target: `AS${asn}`,
        masked: [asn],
      };
    }
    // Hijack: the attacker announces the victim's prefixes, seen at many collectors,
    // repeated so the routes stay; then the victim announces them again.
    for (let at = 2000; at < 60_000; at += 10_000) {
      for (let p = 0; p < 8; p++) {
        const { collector, peer, peerAsn } = peerOf(p);
        for (const prefix of prefixes) {
          s.add(
            at + p * 300,
            'bgp.announce',
            { prefix, collector, asn: SIMULATED_HIJACKER },
            { peer, peerAsn, path: [peerAsn, 174, SIMULATED_HIJACKER], pathLen: 3 },
          );
        }
      }
    }
    for (let p = 0; p < 3; p++) {
      const { collector, peer, peerAsn } = peerOf(p);
      for (const prefix of prefixes) {
        s.add(
          62_000 + p * 500,
          'bgp.announce',
          { prefix, collector, asn },
          { peer, peerAsn, path: [peerAsn, 3356, asn], pathLen: 3 },
        );
      }
    }
    return {
      ...base,
      steps: s.sorted(),
      durationMs: 70_000,
      phases: [
        { name: 'hijack', at: 0 },
        { name: 'recovery', at: 62_000 },
      ],
      asn,
      cc,
      target: `AS${asn}`,
      masked: [asn],
    };
  }

  // Country attacks.
  if (!target.cc) throw new AttackError('Pick a country to target');
  const cc = target.cc;
  // All of them (a big country has hundreds): the detectors judge shares of the country.
  const probes = deps.probesIn(cc).slice(0, 1500);
  if (probes.length < 6) {
    throw new AttackError(
      `Only ${probes.length} Atlas probes are connected in ${cc}; pick another`,
    );
  }
  if (id === 'latency' || id === 'dropout') {
    if (id === 'latency') latencySteps(s, probes, 3000, 75_000);
    else dropoutSteps(s, probes, 2000, 70_000);
    return {
      ...base,
      steps: s.sorted(),
      durationMs: 85_000,
      phases: [
        { name: id, at: 0 },
        { name: 'recovery', at: id === 'latency' ? 75_000 : 70_000 },
      ],
      asn: null,
      cc,
      target: cc,
      masked: [],
    };
  }

  // Blackout: the biggest networks go down, probes slow down and drop off.
  const networks: number[] = [];
  for (const asn of await deps.largestIn(cc, 6)) {
    if (networks.length === 3) break;
    const { prefixes, prime } = await prefixesFor(deps, asn, 20, 200);
    if (prefixes.length < 20) continue;
    if (prime) primeSteps(s, asn, prefixes);
    outageSteps(s, asn, prefixes, 3000, 80_000);
    networks.push(asn);
  }
  if (networks.length === 0) {
    throw new AttackError(`No network registered in ${cc} has enough address blocks yet`);
  }
  // Half the probes go silent (disconnect); the other half report terrible latency.
  latencySteps(s, probes.slice(0, probes.length >> 1), 4000, 80_000);
  dropoutSteps(s, [...probes].reverse(), 6000, 80_000);
  return {
    ...base,
    steps: s.sorted(),
    durationMs: 92_000,
    phases: [
      { name: 'blackout', at: 0 },
      { name: 'gone', at: 35_000 },
      { name: 'recovery', at: 80_000 },
    ],
    asn: null,
    cc,
    target: cc,
    masked: networks,
  };
}
