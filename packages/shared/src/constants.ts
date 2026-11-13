/** Version of the event envelope. Bump it if the shape ever changes. */
export const ENVELOPE_VERSION = 1;

/** Where an event came from. */
export const SOURCES = ['ris', 'atlas', 'radar', 'replay', 'agent'] as const;
export type Source = (typeof SOURCES)[number];

/** What an event describes. The part before the dot names the feed it belongs to. */
export const EVENT_KINDS = [
  'bgp.announce',
  'bgp.withdraw',
  'bgp.peer_state',
  'atlas.ping',
  'atlas.trace',
  'atlas.probe_status',
  'radar.attack_pair',
  'radar.hijack',
  'radar.leak',
  'radar.outage',
  'agent.check',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * Which live source produces each family of kinds. `replay` is not listed
 * because it re-plays recorded events of any kind through the same pipeline.
 */
export const KIND_FAMILY_SOURCE = {
  bgp: 'ris',
  atlas: 'atlas',
  radar: 'radar',
  agent: 'agent',
} as const satisfies Record<string, Source>;

/** Socket.IO namespaces. `/live` is public, `/user` needs a login, `/admin` needs the admin role. */
export const NAMESPACES = {
  live: '/live',
  user: '/user',
  admin: '/admin',
} as const;
export type Namespace = (typeof NAMESPACES)[keyof typeof NAMESPACES];

/** Incident severities, mildest first. */
export const SEVERITIES = ['watch', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Limits that the server enforces and the client respects. */
export const LIMITS = {
  /** A socket may be in at most this many rooms. */
  maxRoomsPerSocket: 20,
  /** Token bucket for `sub`, `unsub` and `resync`, per socket. */
  socketMessagesPerSecond: 5,
  /** Frames kept per room so a client that missed some can ask for them again. */
  ringBufferFrames: 120,
  /** Changes to a room are merged and sent at most once per this many milliseconds. */
  conflateMs: 500,
  /** Slow clients get summaries at this interval instead. */
  slowClientSummaryMs: 2000,
  /** The raw feed sends at most this many events per second to one client. */
  feedEventsPerSecond: 20,
  /** Upper bound on changes inside one frame. */
  maxDeltasPerFrame: 5000,
} as const;
