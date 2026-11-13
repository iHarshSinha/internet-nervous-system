import {
  radarAnomalySchema,
  radarAttackPairSchema,
  radarHijackSchema,
  radarLeakSchema,
  radarOutageSchema,
  type AttackPair,
  type RadarEvent,
} from '@ins/shared';
import { z } from 'zod';
import type { Logger } from '../../logger.ts';

const API = 'https://api.cloudflare.com/client/v4/radar';
const SITE = 'https://radar.cloudflare.com';

/** Radar timestamps: "2026-11-13T19:03:03.679" (no zone, UTC) or with "Z". */
const ms = (iso: string) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
const cc = (c: string | null | undefined) =>
  c && /^[A-Z]{2}$/.test(c.toUpperCase()) ? c.toUpperCase() : null;
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const words = (s: string | undefined) => (s ?? '').toLowerCase().replaceAll('_', ' ');

// ---- normalisers: one Cloudflare record -> one RadarEvent (or null if unusable)

export function fromOutage(raw: unknown): RadarEvent | null {
  const p = radarOutageSchema.safeParse(raw);
  if (!p.success) return null;
  const o = p.data;
  const cause = words(o.outage?.outageCause);
  const countries = uniq(o.locations.map(cc).filter((c): c is string => c !== null));
  const desc = (o.description ?? '').trim();
  return {
    id: `radar:outage:${o.id}`,
    type: 'outage',
    start: ms(o.startDate),
    end: o.endDate ? ms(o.endDate) : null,
    title: (desc ? desc.split(/(?<=\.)\s/)[0]! : `Outage${cause ? ` (${cause})` : ''}`).slice(
      0,
      220,
    ),
    countries,
    asns: o.asns.filter((n) => Number.isInteger(n) && n > 0),
    url: `${SITE}/outage-center`,
  };
}

export function fromAnomaly(raw: unknown): RadarEvent | null {
  const p = radarAnomalySchema.safeParse(raw);
  if (!p.success) return null;
  const a = p.data;
  const asn = a.asnDetails?.asn;
  const country = cc(a.locationDetails?.code ?? a.asnDetails?.location?.code);
  const where = a.asnDetails
    ? `${a.asnDetails.name ?? `AS${asn}`} (AS${asn})`
    : (a.locationDetails?.name ?? country ?? 'a location');
  return {
    id: `radar:anomaly:${a.uuid}`,
    type: 'anomaly',
    start: ms(a.startDate),
    end: a.endDate ? ms(a.endDate) : null,
    title: `Traffic anomaly: ${where} saw an unusual drop in traffic`,
    countries: country ? [country] : [],
    asns: asn && Number.isInteger(asn) ? [asn] : [],
    url: asn ? `${SITE}/as${asn}` : country ? `${SITE}/${country.toLowerCase()}` : SITE,
  };
}

export function fromHijack(raw: unknown): RadarEvent | null {
  const p = radarHijackSchema.safeParse(raw);
  if (!p.success) return null;
  const h = p.data;
  const victims = h.victim_asns.map((v) => `AS${v}`).join(', ');
  return {
    id: `radar:hijack:${h.id}`,
    type: 'hijack',
    start: ms(h.min_hijack_ts),
    end: h.max_hijack_ts ? ms(h.max_hijack_ts) : null,
    title: `Possible BGP hijack: AS${h.hijacker_asn} announced ${h.prefixes.length} prefix${h.prefixes.length === 1 ? '' : 'es'} of ${victims || 'another network'} (confidence ${h.confidence_score})`,
    countries: uniq(h.victim_countries.map(cc).filter((c): c is string => c !== null)),
    asns: h.victim_asns,
    url: `${SITE}/security/routing`,
  };
}

/** Leaks seen by fewer peers than this are left out: most are one session's noise. */
export const LEAK_MIN_PEERS = 10;

export function fromLeak(raw: unknown): RadarEvent | null {
  const p = radarLeakSchema.safeParse(raw);
  if (!p.success) return null;
  const l = p.data;
  return {
    id: `radar:leak:${l.id}`,
    type: 'leak',
    start: ms(l.min_ts),
    end: l.finished && l.max_ts ? ms(l.max_ts) : null,
    title: `Route leak by AS${l.leak_asn}: ${l.prefix_count} prefix${l.prefix_count === 1 ? '' : 'es'}, seen by ${l.peer_count} peers`,
    countries: uniq(l.countries.map(cc).filter((c): c is string => c !== null)),
    asns: [l.leak_asn],
    url: `${SITE}/security/routing`,
  };
}

export function fromPairs(raw: unknown, layer: AttackPair['layer']): AttackPair[] {
  const list = z.array(z.unknown()).safeParse(raw);
  if (!list.success) return [];
  const out: AttackPair[] = [];
  for (const item of list.data) {
    const p = radarAttackPairSchema.safeParse(item);
    if (!p.success) continue;
    const from = cc(p.data.originCountryAlpha2);
    const to = cc(p.data.targetCountryAlpha2);
    if (!from || !to || !Number.isFinite(p.data.value)) continue;
    out.push({ from, to, value: Math.round(p.data.value * 100) / 100, layer });
  }
  return out;
}

// ---- the poller

export interface RadarStats {
  polls: number;
  errors: number;
  events: number;
  rejected: number;
  /** Valid but too small to show (route leaks seen by few peers). */
  filtered: number;
  lastPollAt: number | null;
  lastError: string | null;
}

export interface RadarOptions {
  token: string;
  log: Logger;
  eventsEveryMs: number;
  pairsEveryMs: number;
  /** Every event seen in a poll (old and new; the store dedupes by ID). */
  onEvents(events: RadarEvent[]): void;
  onPairs(pairs: AttackPair[]): void;
  fetchFn?: typeof fetch;
}

const envelope = z.looseObject({ success: z.boolean(), result: z.looseObject({}).optional() });

/**
 * Polls Cloudflare Radar. Each endpoint is fetched in turn (never in
 * parallel bursts), every response is validated, and errors back off
 * exponentially up to 30 minutes so a broken token or an outage at Cloudflare
 * never floods their API.
 */
export class RadarPoller {
  readonly stats: RadarStats = {
    polls: 0,
    errors: 0,
    events: 0,
    rejected: 0,
    filtered: 0,
    lastPollAt: null,
    lastError: null,
  };
  private readonly opts: RadarOptions;
  private readonly fetchFn: typeof fetch;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private failures = 0;

  constructor(opts: RadarOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  start(): void {
    this.loop(() => this.pollEvents(), this.opts.eventsEveryMs, 0);
    this.loop(() => this.pollPairs(), this.opts.pairsEveryMs, 5000);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }

  private loop(task: () => Promise<boolean>, everyMs: number, firstMs: number): void {
    const run = async () => {
      if (this.stopped) return;
      const ok = await task();
      this.failures = ok ? 0 : this.failures + 1;
      const backoff = ok
        ? everyMs
        : Math.min(30 * 60_000, everyMs * 2 ** Math.min(this.failures, 4));
      if (!this.stopped) this.timers.push(setTimeout(() => void run(), backoff).unref());
    };
    this.timers.push(setTimeout(() => void run(), firstMs).unref());
  }

  private async get(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.fetchFn(`${API}/${path}${path.includes('?') ? '&' : '?'}format=json`, {
        headers: { authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path.split('?')[0]}`);
      const body = envelope.parse(await res.json());
      if (!body.success || !body.result) throw new Error(`unsuccessful reply for ${path}`);
      return body.result;
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      this.opts.log.warn({ err: this.stats.lastError }, 'cloudflare radar request failed');
      return null;
    }
  }

  async pollEvents(): Promise<boolean> {
    const parts: [string, string, (raw: unknown) => RadarEvent | null][] = [
      ['annotations/outages?dateRange=7d&limit=50', 'annotations', fromOutage],
      ['traffic_anomalies?dateRange=7d&limit=50', 'trafficAnomalies', fromAnomaly],
      ['bgp/hijacks/events?dateRange=1d&per_page=50&minConfidence=8', 'events', fromHijack],
      ['bgp/leaks/events?dateRange=1d&per_page=50', 'events', fromLeak],
    ];
    const events: RadarEvent[] = [];
    let ok = true;
    for (const [path, key, normalise] of parts) {
      const result = await this.get(path);
      if (!result) {
        ok = false;
        continue;
      }
      const list = Array.isArray(result[key]) ? (result[key] as unknown[]) : [];
      for (const raw of list) {
        if (key === 'events' && path.startsWith('bgp/leaks')) {
          const peers = (raw as { peer_count?: unknown } | null)?.peer_count;
          if (typeof peers === 'number' && peers < LEAK_MIN_PEERS) {
            this.stats.filtered += 1;
            continue;
          }
        }
        const e = normalise(raw);
        if (e && Number.isFinite(e.start)) events.push(e);
        else this.stats.rejected += 1;
      }
    }
    this.stats.polls += 1;
    this.stats.lastPollAt = Date.now();
    this.stats.events = events.length;
    if (events.length > 0) this.opts.onEvents(events);
    return ok;
  }

  async pollPairs(): Promise<boolean> {
    const l7 = await this.get('attacks/layer7/top/attacks?dateRange=1d&limit=20');
    const l3 = await this.get('attacks/layer3/top/attacks?dateRange=1d&limit=20');
    const pairs = [...fromPairs(l7?.top_0, 'l7'), ...fromPairs(l3?.top_0, 'l3')];
    if (pairs.length > 0) this.opts.onPairs(pairs);
    return l7 !== null || l3 !== null;
  }
}
