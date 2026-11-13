import { randomUUID } from 'node:crypto';
import {
  SIGNAL_LABELS,
  severityOf,
  type Incident,
  type IncidentSignal,
  type Signal,
  type SignalType,
} from '@ins/shared';

/** Signals older than this stop counting towards an incident's score. */
const SCORE_WINDOW_MS = 10 * 60_000;
/** A signal not reported for this long is no longer "active". */
const ACTIVE_MS = 5000;
/** All signals quiet for this long: the incident is resolved. */
const RESOLVE_AFTER_MS = 30_000;
/** Only warning and critical open an incident card. */
const OPEN_AT = 0.5;
/** The same scope flaring up again this soon reopens its incident instead of starting a new one. */
const REOPEN_WITHIN_MS = 30 * 60_000;

const fmt = new Intl.NumberFormat('en-US');
const ORDER: SignalType[] = [
  'withdrawal_storm',
  'network_vanished',
  'origin_change',
  'latency_surge',
  'probe_dropout',
];

export interface IncidentDeps {
  /** Network name, if already known (fetched in the background otherwise). */
  nameOf(asn: number): string | null;
  /** Registration country of a network. */
  countryOf(asn: number): string | undefined;
  /** Called when an incident opens or changes in a way people should see. */
  onChange(incident: Incident): void;
}

/** The scope's display name: "Facebook (AS32934)", or "AS64512", or "US". */
function subject(i: Pick<Incident, 'asn' | 'cc' | 'name'>): string {
  if (i.asn !== null) return i.name ? `${i.name} (AS${i.asn})` : `AS${i.asn}`;
  return i.cc ? (new Intl.DisplayNames(['en'], { type: 'region' }).of(i.cc) ?? i.cc) : 'Unknown';
}

/** One sentence per kind of evidence, written from the numbers. No AI: instant, and always matches the data. */
function sentence(type: SignalType, d: Record<string, number | string>, who: string): string {
  switch (type) {
    case 'withdrawal_storm':
      return `${who} withdrew ${fmt.format(Number(d.withdrawals))} routes for ${d.prefixes} address blocks in a minute, seen by ${d.peers} routers, about ${fmt.format(Number(d.times))}× its normal rate.`;
    case 'network_vanished':
      return `${d.gone} of its ${d.known} known address blocks (${d.share}%) have been withdrawn everywhere; ${d.reachable} remain reachable.`;
    case 'origin_change':
      return `${d.prefixes} of its address blocks (for example ${d.example}) are suddenly announced by AS${d.hijacker}, seen at ${d.collectors} collectors: a possible hijack.`;
    case 'latency_surge':
      return `${d.share}% of RIPE Atlas probes there (${d.degraded} of ${d.probes}) are much slower than usual or not answering.`;
    case 'probe_dropout':
      return `${d.disconnected} RIPE Atlas probes there disconnected within five minutes, ${d.share}% of those connected.`;
  }
}

/**
 * Turns signals into incidents.
 *
 *  - Signals are grouped by scope (one network, or one country).
 *  - Score = sum of the weights of signal types seen in the last 10 minutes,
 *    capped at 1. Severity: watch below 0.5, warning from 0.5, critical from 0.8.
 *  - An incident opens at warning. It stays open while signals keep coming,
 *    goes to "resolving" when they stop, and is resolved after a quiet minute.
 */
export class IncidentManager {
  private readonly deps: IncidentDeps;
  /** Live and recently resolved incidents, by scope. */
  private readonly byScope = new Map<string, Incident>();
  /** Signals that have not (yet) added up to an incident. */
  private readonly pending = new Map<string, Map<SignalType, Signal>>();

  constructor(deps: IncidentDeps) {
    this.deps = deps;
  }

  /** Incidents that are open or resolving, newest first. */
  active(): Incident[] {
    return [...this.byScope.values()]
      .filter((i) => i.state !== 'resolved')
      .sort((a, b) => b.openedAt - a.openedAt);
  }

  get(id: string): Incident | undefined {
    return [...this.byScope.values()].find((i) => i.id === id);
  }

  report(signals: Signal[], now: number): void {
    for (const s of signals) {
      const open = this.byScope.get(s.scope);
      if (open && open.state !== 'resolved') this.addSignal(open, s, now);
      else this.consider(s, now);
    }
  }

  /** Not part of an incident yet: does the evidence now add up to one? */
  private consider(s: Signal, now: number): void {
    let bucket = this.pending.get(s.scope);
    if (!bucket) {
      bucket = new Map();
      this.pending.set(s.scope, bucket);
    }
    bucket.set(s.type, s);
    for (const [type, old] of bucket) if (old.at < now - SCORE_WINDOW_MS) bucket.delete(type);
    const score = Math.min(
      1,
      [...bucket.values()].reduce((sum, x) => sum + x.weight, 0),
    );
    if (score < OPEN_AT) return;

    const previous = this.byScope.get(s.scope);
    if (previous && previous.resolvedAt !== null && now - previous.resolvedAt < REOPEN_WITHIN_MS) {
      previous.state = 'open';
      previous.resolvedAt = null;
      previous.timeline.push({ at: now, text: 'Reopened: the signals came back' });
      for (const signal of bucket.values()) this.addSignal(previous, signal, now, false);
      this.pending.delete(s.scope);
      this.refresh(previous, now, true);
      return;
    }

    const [scopeType, key] = s.scope.split(':') as ['asn' | 'country', string];
    const asn = scopeType === 'asn' ? Number(key) : null;
    const incident: Incident = {
      id: randomUUID(),
      scope: s.scope,
      asn,
      cc: asn !== null ? (this.deps.countryOf(asn) ?? null) : key,
      name: asn !== null ? this.deps.nameOf(asn) : null,
      state: 'open',
      severity: severityOf(score),
      score,
      peakScore: score,
      openedAt: now,
      updatedAt: now,
      resolvedAt: null,
      signals: [],
      timeline: [],
      summary: '',
      simulated: [...bucket.values()].some((x) => x.simulated),
    };
    for (const signal of bucket.values()) this.addSignal(incident, signal, now, false);
    incident.timeline.unshift({ at: now, text: `Incident opened (${incident.severity})` });
    this.byScope.set(s.scope, incident);
    this.pending.delete(s.scope);
    this.refresh(incident, now, true);
  }

  private addSignal(incident: Incident, s: Signal, now: number, notify = true): void {
    const existing = incident.signals.find((x) => x.type === s.type);
    if (existing) {
      existing.lastAt = s.at;
      existing.weight = Math.max(existing.weight, s.weight);
      existing.detail = s.detail;
    } else {
      const entry: IncidentSignal = {
        type: s.type,
        firstAt: s.at,
        lastAt: s.at,
        weight: s.weight,
        detail: s.detail,
      };
      incident.signals.push(entry);
      incident.timeline.push({
        at: s.at,
        text: `${SIGNAL_LABELS[s.type]}: ${sentence(s.type, s.detail, subject(incident))}`,
      });
      if (notify && incident.state !== 'open')
        incident.timeline.push({ at: now, text: 'Signals returned' });
    }
    if (s.simulated) incident.simulated = true;
    if (notify) this.refresh(incident, now, !existing);
  }

  /** Re-score, update the state and the summary, and tell listeners if something visible changed. */
  private refresh(incident: Incident, now: number, force = false): void {
    const before = `${incident.state}|${incident.severity}|${incident.score.toFixed(2)}|${incident.summary}|${incident.name}`;
    const counted = incident.signals.filter((s) => s.lastAt >= now - SCORE_WINDOW_MS);
    incident.score = Math.min(
      1,
      counted.reduce((sum, s) => sum + s.weight, 0),
    );
    incident.peakScore = Math.max(incident.peakScore, incident.score);
    incident.severity = severityOf(incident.peakScore);

    const active = incident.signals.some((s) => s.lastAt >= now - ACTIVE_MS);
    const lastSignal = Math.max(...incident.signals.map((s) => s.lastAt));
    if (incident.state !== 'resolved') {
      if (active && incident.state === 'resolving') {
        incident.state = 'open';
      } else if (!active && incident.state === 'open') {
        incident.state = 'resolving';
        incident.timeline.push({ at: now, text: 'Signals stopped; watching for recovery' });
      } else if (!active && now - lastSignal >= RESOLVE_AFTER_MS) {
        incident.state = 'resolved';
        incident.resolvedAt = now;
        incident.timeline.push({
          at: now,
          text: `Resolved after ${Math.max(1, Math.round((now - incident.openedAt) / 60_000))} min`,
        });
      }
    }

    const who = subject(incident);
    const parts = ORDER.map((t) => incident.signals.find((s) => s.type === t))
      .filter((s): s is IncidentSignal => s !== undefined)
      .map((s) => sentence(s.type, s.detail, who));
    if (incident.state === 'resolving')
      parts.push('The signals have stopped; checking that it stays recovered.');
    if (incident.state === 'resolved') parts.push('It has recovered.');
    if (incident.simulated)
      parts.push('This incident was raised by a simulation triggered by an admin.');
    incident.summary = parts.join(' ');
    if (incident.timeline.length > 60) incident.timeline.splice(1, incident.timeline.length - 60);

    const after = `${incident.state}|${incident.severity}|${incident.score.toFixed(2)}|${incident.summary}|${incident.name}`;
    if (force || after !== before) {
      incident.updatedAt = now;
      this.deps.onChange(incident);
    }
  }

  /** Once a second: update states (open -> resolving -> resolved) even when no signal arrives. */
  tick(now: number): void {
    for (const [scope, incident] of this.byScope) {
      if (incident.state === 'resolved') {
        if (incident.resolvedAt! < now - 30 * 60_000) this.byScope.delete(scope);
        continue;
      }
      if (incident.asn !== null && !incident.name) incident.name = this.deps.nameOf(incident.asn);
      this.refresh(incident, now);
    }
    for (const [scope, bucket] of this.pending) {
      for (const [type, s] of bucket) if (s.at < now - SCORE_WINDOW_MS) bucket.delete(type);
      if (bucket.size === 0) this.pending.delete(scope);
    }
  }
}
