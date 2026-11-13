import { z } from 'zod';

/*
 * Cloudflare Radar: an outside view of the internet. We poll its REST API
 * (outage annotations, traffic anomalies, BGP hijacks and route leaks every
 * few minutes; layer 7 and layer 3 attack pairs every 15 minutes). Radar data
 * is licensed CC BY-NC 4.0 and is credited wherever it is shown.
 *
 * The schemas below accept Cloudflare's responses loosely (extra fields are
 * kept, unknown ones ignored) but insist on the fields we use.
 */

const isoDate = z.string().min(10).max(40);

export const radarOutageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  description: z.string().nullable().optional(),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  locations: z.array(z.string()).default([]),
  asns: z.array(z.union([z.number(), z.string()]).transform(Number)).default([]),
  outage: z
    .looseObject({ outageCause: z.string().optional(), outageType: z.string().optional() })
    .nullable()
    .optional(),
  linkedUrl: z.string().nullable().optional(),
});

export const radarAnomalySchema = z.looseObject({
  uuid: z.string(),
  type: z.string(),
  status: z.string().optional(),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  locationDetails: z
    .looseObject({ code: z.string(), name: z.string().optional() })
    .nullable()
    .optional(),
  asnDetails: z
    .looseObject({
      asn: z.union([z.string(), z.number()]).transform(Number),
      name: z.string().optional(),
      location: z.looseObject({ code: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const radarHijackSchema = z.looseObject({
  id: z.number(),
  hijacker_asn: z.number(),
  hijacker_country: z.string().nullable().optional(),
  victim_asns: z.array(z.number()).default([]),
  victim_countries: z.array(z.string()).default([]),
  prefixes: z.array(z.string()).default([]),
  min_hijack_ts: isoDate,
  max_hijack_ts: isoDate.optional(),
  confidence_score: z.number().default(0),
  peer_ip_count: z.number().default(0),
});

export const radarLeakSchema = z.looseObject({
  id: z.number(),
  leak_asn: z.number(),
  countries: z.array(z.string()).default([]),
  min_ts: isoDate,
  max_ts: isoDate.optional(),
  finished: z.boolean().optional(),
  prefix_count: z.number().default(0),
  peer_count: z.number().default(0),
});

export const radarAttackPairSchema = z.looseObject({
  originCountryAlpha2: z.string(),
  targetCountryAlpha2: z.string(),
  value: z.union([z.string(), z.number()]).transform(Number),
});

export const RADAR_TYPES = ['outage', 'anomaly', 'hijack', 'leak'] as const;
export type RadarType = (typeof RADAR_TYPES)[number];

/** One Radar event, as we store and show it. */
export interface RadarEvent {
  /** "radar:<type>:<cloudflare id>", globally unique and stable across polls. */
  id: string;
  type: RadarType;
  /** When it started and (if over) ended, in ms. */
  start: number;
  end: number | null;
  /** One line for people. */
  title: string;
  countries: string[];
  asns: number[];
  /** Link to the event on radar.cloudflare.com. */
  url: string;
}

/** Share of layer 7 (or layer 3) attack traffic from one country to another, last 24 h. */
export interface AttackPair {
  from: string;
  to: string;
  /** Percentage of all attack traffic. */
  value: number;
  layer: 'l7' | 'l3';
}

/** Reply of GET /api/radar. `enabled` is false when no Cloudflare token is configured. */
export interface RadarResponse {
  enabled: boolean;
  snapshotSeq: number;
  updatedAt: number | null;
  events: RadarEvent[];
  pairs: AttackPair[];
}

/** Deltas in the `arcs` room: ["pairs", "v", AttackPair[]] and ["radar:<id>", "v", RadarEvent]. */
export const PAIRS_KEY = 'pairs';
