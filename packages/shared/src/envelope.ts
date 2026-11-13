import { z } from 'zod';
import {
  ENVELOPE_VERSION,
  EVENT_KINDS,
  KIND_FAMILY_SOURCE,
  SOURCES,
  type EventKind,
  type Source,
} from './constants.ts';
import { asnSchema, countryCodeSchema, epochMsSchema } from './primitives.ts';

export const sourceSchema = z.enum(SOURCES);
export const eventKindSchema = z.enum(EVENT_KINDS);

/** What the event is about. Every field is optional; each source fills in what it knows. */
export const entitySchema = z.object({
  /** Network (autonomous system) the event concerns, for example the origin of a route. */
  asn: asnSchema.optional(),
  /** IP prefix in CIDR form, for example "129.134.30.0/24". */
  prefix: z.string().max(64).optional(),
  /** Country where the network is registered, or where the probe physically is. */
  cc: countryCodeSchema.optional(),
  /** RIS route collector, for example "rrc10". */
  collector: z.string().max(16).optional(),
  /** RIPE Atlas probe ID. */
  probeId: z.number().int().min(0).optional(),
  /** RIPE Atlas measurement ID. */
  msmId: z.number().int().min(0).optional(),
  /** Our own probe agent's device ID. */
  deviceId: z.string().max(64).optional(),
});
export type Entity = z.infer<typeof entitySchema>;

/**
 * The one shape every event takes, whatever its source.
 *
 * - `src` + `eid` identify the event; `eid` is globally unique and is the dedupe key.
 * - `ts` is event time (when it happened, according to the source).
 * - `its` is ingest time (when our server received it). `its - ts` is source-to-server latency.
 */
export const eventEnvelopeSchema = z
  .object({
    v: z.literal(ENVELOPE_VERSION),
    src: sourceSchema,
    eid: z.string().min(3).max(200),
    kind: eventKindSchema,
    ts: epochMsSchema,
    its: epochMsSchema,
    entity: entitySchema,
    data: z.record(z.string(), z.unknown()),
  })
  .refine((e) => e.eid.startsWith(`${e.src}:`), {
    path: ['eid'],
    message: 'eid must start with "<src>:"',
  })
  .refine((e) => kindAllowedFrom(e.kind, e.src), {
    path: ['kind'],
    message: 'this kind of event cannot come from this source',
  });
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** True if `src` is allowed to produce events of `kind`. Replay may produce any kind. */
export function kindAllowedFrom(kind: EventKind, src: Source): boolean {
  if (src === 'replay') return true;
  const family = kind.slice(0, kind.indexOf('.')) as keyof typeof KIND_FAMILY_SOURCE;
  return KIND_FAMILY_SOURCE[family] === src;
}

/**
 * Build an event ID. One upstream message can carry several items (a RIS
 * update lists many prefixes), so each item gets its own event: `#0`, `#1`, ...
 */
export function makeEid(src: Source, upstreamId: string, part?: number): string {
  return part === undefined ? `${src}:${upstreamId}` : `${src}:${upstreamId}#${part}`;
}
