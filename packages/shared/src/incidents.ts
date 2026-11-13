import type { Severity } from './constants.ts';

/** What the detectors can notice. Each produces signals; signals add up to incidents. */
export const SIGNAL_TYPES = [
  'withdrawal_storm', // D1
  'network_vanished', // D1b
  'origin_change', // D2: possible hijack
  'latency_surge', // D3
  'probe_dropout', // D4
  'cloudflare', // D6: Cloudflare Radar reports something in the same place
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/**
 * How much each kind of evidence counts. An incident's score is the sum of
 * its recent signals' weights, capped at 1. Several independent signals
 * agreeing is what makes an incident serious, which keeps false alarms down.
 */
export const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  withdrawal_storm: 0.4,
  network_vanished: 0.6,
  origin_change: 0.5,
  latency_surge: 0.2,
  probe_dropout: 0.3,
  cloudflare: 0.3,
};

export const SIGNAL_LABELS: Record<SignalType, string> = {
  withdrawal_storm: 'Withdrawal storm',
  network_vanished: 'Network vanished',
  origin_change: 'Possible hijack',
  latency_surge: 'Latency surge',
  probe_dropout: 'Probes dropped off',
  cloudflare: 'Cloudflare Radar',
};

/** Below 0.5 is only "watch" and opens no incident; warning from 0.5, critical from 0.8. */
export function severityOf(score: number): Severity {
  if (score >= 0.8) return 'critical';
  if (score >= 0.5) return 'warning';
  return 'watch';
}

/** One piece of evidence from a detector. */
export interface Signal {
  type: SignalType;
  /** "asn:32934" or "country:US". */
  scope: string;
  at: number;
  weight: number;
  /** Numbers behind the signal, for the explanation and the evidence view. */
  detail: Record<string, number | string>;
  /** True if most of the events behind it were injected by a scenario. */
  simulated: boolean;
}

export const INCIDENT_STATES = ['open', 'resolving', 'resolved'] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export interface IncidentSignal {
  type: SignalType;
  firstAt: number;
  lastAt: number;
  weight: number;
  detail: Record<string, number | string>;
}

export interface Incident {
  id: string;
  scope: string;
  asn: number | null;
  /** Country the network is registered in, or the country itself. */
  cc: string | null;
  /** Network name (from RIPEstat), when known. */
  name: string | null;
  state: IncidentState;
  severity: Severity;
  score: number;
  peakScore: number;
  openedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  signals: IncidentSignal[];
  /** What happened, in order, in plain words. */
  timeline: { at: number; text: string }[];
  /** One plain-language paragraph, generated from the numbers (no AI involved). */
  summary: string;
  /** Raised by an admin-triggered scenario rather than real traffic. */
  simulated: boolean;
}

/** GET /api/incidents. `snapshotSeq` is the incidents room's sequence number. */
export interface IncidentsResponse {
  snapshotSeq: number;
  incidents: Incident[];
}

/** Incident deltas: ["inc:<id>", "v", Incident] in the incidents, country and network rooms. */
export const incidentKey = (id: string) => `inc:${id}`;
