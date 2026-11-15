import { SIGNAL_WEIGHTS, type EventEnvelope, type RadarEvent, type Signal } from '@ins/shared';
import type { OriginTable } from '../pipeline/origins.ts';
import type { EventContext } from '../pipeline/pipeline.ts';
import { MinuteBaseline, SecondRing } from './baseline.ts';

/*
 * The detectors. Each looks for one kind of trouble and produces signals;
 * the incident manager adds signals up. Thresholds are the plan's starting
 * values, tuned on recorded data (see docs/architecture.md "Detection design").
 */

export const THRESHOLDS = {
  /** D1: robust z-score and distinct prefixes withdrawn in the last 60 s. */
  stormZ: 6,
  stormPrefixes: 20,
  /** Distinct routers that must report the withdrawals. Measured live: 2 let one flapping session through. */
  stormPeers: 5,
  /** D1: a storm seen this widely, or this many times above normal, counts for more. */
  stormWidePeers: 20,
  stormExtremeTimes: 100,
  /**
   * D1b: share of a network's known prefixes currently withdrawn. Measured on
   * the 2021 Facebook outage: at worst 43 of 147 (29%), because routers kept
   * re-announcing some prefixes while hunting for paths. Full weight at 40%.
   */
  vanishedShare: 0.15,
  vanishedFullShare: 0.4,
  vanishedMinPrefixes: 15,
  /** Distinct routers that sent withdrawals for the network in the last 5 minutes. */
  vanishedPeers: 20,
  /**
   * A prefix counts as gone only if this many different routers withdrew it
   * in the last 5 minutes and nothing re-announced it since. One router
   * dropping a path is everyday churn; Facebook's were withdrawn by ~100.
   * Tuned on a 30-minute live recording: 5 raised 19 incidents, 20 raised 9.
   */
  goneWithdrawers: 20,
  /** A network needs this many minutes of history before it can raise a storm. */
  baselineMinutes: 10,
  /** D2: a new origin must be seen at this many collectors. */
  hijackCollectors: 3,
  /** D3: share of a country's probes that must be degraded. */
  latencyShare: 0.3,
  latencyMinProbes: 5,
  latencyTrustedProbes: 20,
  /** D4: disconnects in 5 minutes, and share of the country's probes. */
  dropoutMin: 5,
  dropoutShare: 0.2,
} as const;

const MIN = 60_000;

/** Per network or country: recent routing activity. */
interface Activity {
  wd: SecondRing;
  ann: SecondRing;
  simWd: SecondRing;
  /** prefix -> last time it was withdrawn (for distinct counts). */
  withdrawn: Map<string, number>;
  /** "collector:peer" -> last time it sent a withdrawal here. */
  peers: Map<string, number>;
  /** Networks only: prefix -> (router -> when it withdrew it), last 5 minutes. */
  withdrawers: Map<string, Map<string, number>>;
  lastAt: number;
  lastSimulatedAt: number;
}

/** One probe's history against ONE measurement target (targets differ in distance). */
interface ProbeState {
  id: number;
  ewma: number;
  n: number;
  degraded: boolean;
  at: number;
  cc: string;
  simulated: boolean;
}

interface HijackCandidate {
  victim: number;
  hijacker: number;
  prefix: string;
  collectors: Set<string>;
  firstAt: number;
  confirmedAt: number | null;
  simulated: boolean;
}

export interface DetectorDeps {
  origins: OriginTable;
  /** Connected Atlas probes in a country (for the dropout share). */
  connectedProbes(cc: string): number;
}

/** Baseline of a network we have watched and seen no withdrawals from. */
const QUIET = new MinuteBaseline();
for (let i = 0; i < 60; i++) QUIET.push(0);

export class Detectors {
  private readonly deps: DetectorDeps;
  private readonly activity = new Map<string, Activity>();
  private readonly baselines = new Map<string, MinuteBaseline>();
  /** Keyed by "probe:measurement". */
  private readonly probes = new Map<string, ProbeState>();
  private readonly disconnects = new Map<string, Map<number, { at: number; simulated: boolean }>>();
  private readonly hijacks = new Map<string, HijackCandidate>();
  /** Prefix/origin pairs already judged legitimate (seen flipping back), with expiry. */
  private readonly legitimate = new Map<string, number>();
  /** When each scope last stormed: its baseline is frozen meanwhile, so a storm cannot redefine normal. */
  private readonly stormAt = new Map<string, number>();
  private lastNow = 0;
  /** Cloudflare Radar events by ID (D6). */
  private readonly radar = new Map<string, RadarEvent>();
  /** Closed routing minutes since start: how long we have been watching every network. */
  private minutesWatched = 0;

  constructor(deps: DetectorDeps) {
    this.deps = deps;
  }

  private act(key: string): Activity {
    let a = this.activity.get(key);
    if (!a) {
      a = {
        wd: new SecondRing(),
        ann: new SecondRing(),
        simWd: new SecondRing(),
        withdrawn: new Map(),
        peers: new Map(),
        withdrawers: new Map(),
        lastAt: 0,
        lastSimulatedAt: 0,
      };
      this.activity.set(key, a);
    }
    return a;
  }

  /** Feed one deduplicated, attributed event. */
  observe(event: EventEnvelope, ctx: EventContext, now: number): void {
    if (ctx.masked) return;
    const simulated = event.data.simulated === true;
    if (event.kind === 'bgp.withdraw' || event.kind === 'bgp.announce') {
      this.observeRoute(event, ctx, simulated, now);
    } else if (event.kind === 'atlas.ping') {
      this.observePing(event, ctx, simulated);
    } else if (event.kind === 'atlas.probe_status' && ctx.cc) {
      this.observeStatus(event, ctx.cc, simulated);
    }
  }

  private observeRoute(
    event: EventEnvelope,
    ctx: EventContext,
    simulated: boolean,
    now: number,
  ): void {
    const keys = [
      ctx.asn !== undefined ? `asn:${ctx.asn}` : null,
      ctx.cc ? `country:${ctx.cc}` : null,
    ];
    const peer = `${event.entity.collector ?? '?'}:${String(event.data.peer ?? event.data.peerAsn ?? '?')}`;
    for (const key of keys) {
      if (!key) continue;
      const a = this.act(key);
      a.lastAt = now;
      if (simulated) a.lastSimulatedAt = now;
      if (event.kind === 'bgp.withdraw') {
        a.wd.add(event.ts);
        if (simulated) a.simWd.add(event.ts);
        if (event.entity.prefix) {
          a.withdrawn.set(event.entity.prefix, event.ts);
          if (key.startsWith('asn:')) {
            let who = a.withdrawers.get(event.entity.prefix);
            if (!who) {
              who = new Map();
              a.withdrawers.set(event.entity.prefix, who);
            }
            who.set(peer, event.ts);
          }
        }
        a.peers.set(peer, event.ts);
      } else {
        a.ann.add(event.ts);
      }
    }
    if (event.kind === 'bgp.announce' && ctx.asn !== undefined) {
      if (ctx.prevOrigin !== undefined) {
        this.observeOriginChange(event, ctx.prevOrigin, ctx.asn, simulated);
      } else {
        // The table already shows the new owner after the first sighting, so
        // later collectors' announcements confirm an existing candidate here.
        const candidate = this.hijacks.get(`${event.entity.prefix}|${ctx.asn}`);
        if (candidate) {
          candidate.collectors.add(event.entity.collector ?? '?');
          if (
            candidate.confirmedAt === null &&
            candidate.collectors.size >= THRESHOLDS.hijackCollectors
          ) {
            candidate.confirmedAt = event.ts;
          }
        }
      }
    }
  }

  /** D2 input: a prefix announced by a different network than before. */
  private observeOriginChange(
    event: EventEnvelope,
    victim: number,
    hijacker: number,
    simulated: boolean,
  ): void {
    const prefix = event.entity.prefix!;
    const now = event.ts;
    // The old owner flipping back means these two share the prefix legitimately.
    const reverse = `${prefix}|${victim}`;
    if (this.hijacks.has(reverse)) {
      this.hijacks.delete(reverse);
      this.legitimate.set(`${prefix}|${victim}|${hijacker}`, now + 24 * 60 * MIN);
      this.legitimate.set(`${prefix}|${hijacker}|${victim}`, now + 24 * 60 * MIN);
      return;
    }
    if ((this.legitimate.get(`${prefix}|${victim}|${hijacker}`) ?? 0) > now) return;
    // If the old owner is on the new path, it is a customer or provider route, not a theft.
    const path = Array.isArray(event.data.path) ? (event.data.path as unknown[]) : [];
    if (path.includes(victim)) return;

    const key = `${prefix}|${hijacker}`;
    let c = this.hijacks.get(key);
    if (!c) {
      c = {
        victim,
        hijacker,
        prefix,
        collectors: new Set(),
        firstAt: now,
        confirmedAt: null,
        simulated,
      };
      this.hijacks.set(key, c);
    }
    c.collectors.add(event.entity.collector ?? '?');
    if (c.confirmedAt === null && c.collectors.size >= THRESHOLDS.hijackCollectors)
      c.confirmedAt = now;
  }

  /** D3 input: one probe's ping result against its own usual latency. */
  private observePing(event: EventEnvelope, ctx: EventContext, simulated: boolean): void {
    const id = event.entity.probeId;
    if (id === undefined || !ctx.cc) return;
    const rtt = typeof event.data.rtt === 'number' ? event.data.rtt : null;
    // Each probe pings several targets at different distances. Its usual time
    // is kept per target; mixing them made the far target look like a slowdown.
    const key = `${id}:${event.entity.msmId ?? 0}`;
    const p = this.probes.get(key) ?? {
      id,
      ewma: 0,
      n: 0,
      degraded: false,
      at: 0,
      cc: ctx.cc,
      simulated,
    };
    const warm = p.n >= 3;
    // Degraded: no reply at all, or more than double its usual time (plus 10 ms of slack).
    p.degraded = rtt === null || (warm && rtt > 2 * p.ewma + 10);
    if (rtt !== null && !p.degraded) {
      p.ewma = p.n === 0 ? rtt : 0.8 * p.ewma + 0.2 * rtt;
      p.n += 1;
    }
    p.at = event.ts;
    p.cc = ctx.cc;
    p.simulated = simulated;
    this.probes.set(key, p);
  }

  /** D4 input: probes disconnecting. */
  private observeStatus(event: EventEnvelope, cc: string, simulated: boolean): void {
    const id = event.entity.probeId;
    if (id === undefined) return;
    let map = this.disconnects.get(cc);
    if (!map) {
      map = new Map();
      this.disconnects.set(cc, map);
    }
    if (event.data.event === 'disconnect') map.set(id, { at: event.ts, simulated });
    else map.delete(id); // reconnected
  }

  /** A closed 1-minute routing window: extend each network's and country's history. */
  onMinute(scopes: Map<string, { wd: number }>): void {
    const frozen = (scope: string) =>
      (this.stormAt.get(scope) ?? -Infinity) > this.lastNow - 10 * MIN;
    for (const [scope, totals] of scopes) {
      if (!scope.startsWith('asn:') && !scope.startsWith('country:')) continue;
      let b = this.baselines.get(scope);
      if (!b) {
        // A network seen for the first time was quiet for every minute we have been watching.
        b = new MinuteBaseline();
        for (let i = 0; i < Math.min(this.minutesWatched, THRESHOLDS.baselineMinutes); i++)
          b.push(0);
        this.baselines.set(scope, b);
      }
      if (!frozen(scope)) b.push(totals.wd);
    }
    // Quiet minutes count as zero for everyone not in this window.
    for (const [scope, b] of this.baselines) {
      if (!scopes.has(scope) && !frozen(scope)) b.push(0);
      if (b.count >= 30 && b.idle) this.baselines.delete(scope);
    }
    this.minutesWatched += 1;
  }

  /**
   * After a restart: rebuild "normal" from stored minutes so storms can be
   * judged at once. `covered` are the minutes we were running; a network
   * without a stored value for a covered minute was not among the busiest,
   * so it counts as 0 that minute.
   */
  warmStart(covered: number[], wd: Map<string, Map<number, number>>): void {
    for (const [scope, minutes] of wd) {
      this.seed(
        scope,
        covered.map((t) => minutes.get(t) ?? 0),
      );
    }
    this.minutesWatched = Math.max(this.minutesWatched, covered.length);
  }

  /** Seed a baseline from stored history (minute withdrawal counts, oldest first). */
  seed(scope: string, minutes: number[]): void {
    const b = new MinuteBaseline();
    for (const v of minutes) b.push(v);
    this.baselines.set(scope, b);
  }

  /** Run the detectors that look at the recent past. Called every second. */
  evaluate(now: number): Signal[] {
    this.lastNow = now;
    const signals: Signal[] = [];
    for (const [key, a] of this.activity) {
      // Forget prefixes and peers older than the windows we use.
      for (const [p, t] of a.withdrawn) if (t < now - 10 * MIN) a.withdrawn.delete(p);
      for (const [p, t] of a.peers) if (t < now - 5 * MIN) a.peers.delete(p);
      for (const [prefix, who] of a.withdrawers) {
        for (const [p, t] of who) if (t < now - 5 * MIN) who.delete(p);
        if (who.size === 0) a.withdrawers.delete(prefix);
      }
      if (a.lastAt < now - 15 * MIN) {
        this.activity.delete(key);
        continue;
      }
      const storm = this.storm(key, a, now);
      if (storm) signals.push(storm);
      if (key.startsWith('asn:')) {
        const vanished = this.vanished(key, a, now);
        if (vanished) signals.push(vanished);
      }
    }
    signals.push(
      ...this.hijackSignals(now),
      ...this.latency(now),
      ...this.dropouts(now),
      ...this.radarSignals(now),
    );
    return signals;
  }

  /** D6 input: events from Cloudflare Radar (re-sent every poll; kept by ID). */
  observeRadar(events: RadarEvent[]): void {
    for (const e of events) this.radar.set(e.id, e);
  }

  /**
   * D6: Cloudflare Radar reports something for the same network or country
   * right now (ongoing, or ended in the last 30 minutes). On its own it never
   * opens an incident (0.3); it confirms ours, from an independent vantage point.
   */
  private radarSignals(now: number): Signal[] {
    const out: Signal[] = [];
    for (const [id, e] of this.radar) {
      const current = e.end === null ? e.start > now - 3 * 24 * 60 * MIN : e.end > now - 30 * MIN;
      if (!current) {
        if ((e.end ?? e.start) < now - 7 * 24 * 60 * MIN) this.radar.delete(id);
        continue;
      }
      if (e.start > now + MIN) continue;
      // Hijacks and leaks are about networks; outages and anomalies also about countries.
      const byCountry = e.type === 'outage' || e.type === 'anomaly';
      const scopes = [
        ...e.asns.map((a) => `asn:${a}`),
        ...(byCountry ? e.countries.map((c) => `country:${c}`) : []),
      ];
      for (const scope of scopes) {
        out.push({
          type: 'cloudflare',
          scope,
          at: now,
          weight: SIGNAL_WEIGHTS.cloudflare,
          detail: { title: e.title, kind: e.type, url: e.url },
          simulated: false,
        });
      }
    }
    return out;
  }

  /** D1: far more withdrawals than this network or country normally sends. */
  private storm(key: string, a: Activity, now: number): Signal | null {
    const wd = a.wd.sum(now, 60);
    if (wd < THRESHOLDS.stormPrefixes) return null;
    let prefixes = 0;
    for (const t of a.withdrawn.values()) if (t > now - MIN) prefixes += 1;
    let peers = 0;
    for (const t of a.peers.values()) if (t > now - MIN) peers += 1;
    // Without enough history we cannot know what is normal for this network.
    // A missing baseline after enough watching means the network has been quiet (idle ones are dropped).
    const base =
      this.baselines.get(key) ??
      (this.minutesWatched >= THRESHOLDS.baselineMinutes ? QUIET : undefined);
    if (!base || base.count < THRESHOLDS.baselineMinutes) return null;
    const z = base.z(wd);
    if (
      z <= THRESHOLDS.stormZ ||
      prefixes < THRESHOLDS.stormPrefixes ||
      peers < THRESHOLDS.stormPeers
    ) {
      return null;
    }
    const normal = base.median();
    const times = Math.round(wd / Math.max(1, normal));
    this.stormAt.set(key, now);
    // A network's storm seen by many routers, or far above normal, is stronger
    // evidence. Country storms stay at the base weight: they mostly echo one
    // network's storm, which has its own incident.
    let weight = SIGNAL_WEIGHTS.withdrawal_storm;
    if (key.startsWith('asn:')) {
      if (peers >= THRESHOLDS.stormWidePeers) weight += 0.1;
      // Far above normal counts only when it is also seen widely, not by a handful of routers.
      if (times >= THRESHOLDS.stormExtremeTimes && peers >= THRESHOLDS.stormWidePeers / 2)
        weight += 0.1;
    }
    return {
      type: 'withdrawal_storm',
      scope: key,
      at: now,
      weight: Math.round(weight * 100) / 100,
      detail: {
        withdrawals: wd,
        prefixes,
        peers,
        normalPerMinute: Math.round(normal),
        times,
      },
      simulated: a.simWd.sum(now, 60) * 2 > wd,
    };
  }

  /** D1b: most of a network's prefixes withdrawn, by several peers: it has gone dark. */
  private vanished(key: string, a: Activity, now: number): Signal | null {
    const asn = Number(key.slice(4));
    const { known } = this.deps.origins.reach(asn);
    // Gone = withdrawn widely (several routers) and not announced again since.
    let gone = 0;
    for (const [prefix, who] of a.withdrawers) {
      if (who.size >= THRESHOLDS.goneWithdrawers && this.deps.origins.isWithdrawn(prefix))
        gone += 1;
    }
    if (known < THRESHOLDS.vanishedMinPrefixes || gone < THRESHOLDS.vanishedMinPrefixes)
      return null;
    const share = gone / known;
    if (share < THRESHOLDS.vanishedShare) return null;
    if (a.peers.size < THRESHOLDS.vanishedPeers) return null;
    // The more of the network is gone, the more this counts (full weight at 40%).
    const weight =
      SIGNAL_WEIGHTS.network_vanished * Math.min(1, share / THRESHOLDS.vanishedFullShare);
    return {
      type: 'network_vanished',
      scope: key,
      at: now,
      weight: Math.round(weight * 100) / 100,
      detail: {
        known,
        gone,
        reachable: known - gone,
        share: Math.round(share * 100),
        peers: a.peers.size,
      },
      simulated: a.lastSimulatedAt > now - 10 * MIN,
    };
  }

  /** D2: prefixes of one network now announced by another, confirmed at two collectors. */
  private hijackSignals(now: number): Signal[] {
    const groups = new Map<string, HijackCandidate[]>();
    for (const [key, c] of this.hijacks) {
      if (c.firstAt < now - 10 * MIN) {
        this.hijacks.delete(key);
        continue;
      }
      if (c.confirmedAt === null) continue;
      const g = `${c.victim}|${c.hijacker}`;
      groups.set(g, [...(groups.get(g) ?? []), c]);
    }
    for (const [k, until] of this.legitimate) if (until < now) this.legitimate.delete(k);

    return [...groups.values()].map((list) => {
      const first = list[0]!;
      // One prefix is suspicious; several from the same thief is serious.
      // A lone prefix seen at a new origin is often legitimate (anycast, DDoS scrubbing): watch only.
      const weight = Math.round((0.3 + 0.05 * Math.min(list.length, 6)) * 100) / 100;
      return {
        type: 'origin_change' as const,
        scope: `asn:${first.victim}`,
        at: now,
        weight,
        detail: {
          hijacker: first.hijacker,
          prefixes: list.length,
          example: first.prefix,
          collectors: Math.max(...list.map((c) => c.collectors.size)),
        },
        simulated: list.every((c) => c.simulated),
      };
    });
  }

  /** D3: a large share of a country's probes much slower than usual, or not answering. */
  private latency(now: number): Signal[] {
    // A probe counts as degraded only if every target it measured recently is slow or silent:
    // one bad path is that target's problem, all of them is the probe's own network.
    const perProbe = new Map<number, { cc: string; ok: boolean; simulated: boolean }>();
    for (const [key, p] of this.probes) {
      if (p.at < now - 30 * MIN) {
        this.probes.delete(key);
        continue;
      }
      if (p.at < now - 10 * MIN || p.n < 3) continue;
      const probe = perProbe.get(p.id) ?? { cc: p.cc, ok: false, simulated: false };
      if (!p.degraded) probe.ok = true;
      if (p.simulated) probe.simulated = true;
      perProbe.set(p.id, probe);
    }
    const byCountry = new Map<string, { total: number; degraded: number; simulated: number }>();
    for (const probe of perProbe.values()) {
      const c = byCountry.get(probe.cc) ?? { total: 0, degraded: 0, simulated: 0 };
      c.total += 1;
      if (!probe.ok) c.degraded += 1;
      if (probe.simulated) c.simulated += 1;
      byCountry.set(probe.cc, c);
    }
    const out: Signal[] = [];
    for (const [cc, c] of byCountry) {
      if (c.total < THRESHOLDS.latencyMinProbes || c.degraded / c.total < THRESHOLDS.latencyShare)
        continue;
      // Most of a country slowing down at once is serious on its own: 0.2 at 30%, 0.5 from 70%.
      // Only where enough probes report to trust a share (a country with 7 probes stays at 0.2).
      const share = c.degraded / c.total;
      const boost =
        c.total >= THRESHOLDS.latencyTrustedProbes
          ? Math.min(1, Math.max(0, (share - 0.3) / 0.4))
          : 0;
      const weight = SIGNAL_WEIGHTS.latency_surge + 0.3 * boost;
      out.push({
        type: 'latency_surge',
        scope: `country:${cc}`,
        at: now,
        weight: Math.round(weight * 100) / 100,
        detail: {
          probes: c.total,
          degraded: c.degraded,
          share: Math.round((c.degraded / c.total) * 100),
        },
        simulated: c.simulated * 2 > c.total,
      });
    }
    return out;
  }

  /** D4: many of a country's probes disconnecting within five minutes. */
  private dropouts(now: number): Signal[] {
    const out: Signal[] = [];
    for (const [cc, map] of this.disconnects) {
      for (const [id, d] of map) if (d.at < now - 5 * MIN) map.delete(id);
      const count = map.size;
      const connected = this.deps.connectedProbes(cc);
      if (count < THRESHOLDS.dropoutMin || count < THRESHOLDS.dropoutShare * connected) continue;
      const simulated = [...map.values()].filter((d) => d.simulated).length * 2 > count;
      // 0.3 at 20% of the country's probes, 0.6 from half of them.
      const share = count / Math.max(1, connected);
      const weight =
        SIGNAL_WEIGHTS.probe_dropout + 0.3 * Math.min(1, Math.max(0, (share - 0.2) / 0.3));
      out.push({
        type: 'probe_dropout',
        scope: `country:${cc}`,
        at: now,
        weight: Math.round(weight * 100) / 100,
        detail: {
          disconnected: count,
          connected,
          share: Math.round((count / Math.max(1, connected)) * 100),
        },
        simulated,
      });
    }
    return out;
  }
}
