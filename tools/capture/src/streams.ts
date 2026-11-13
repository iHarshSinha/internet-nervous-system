import {
  atlasFrameSchema,
  atlasPingSchema,
  atlasProbeStatusSchema,
  risEventCount,
  risMessageSchema,
} from '@ins/shared';
import type WebSocket from 'ws';

/** What we learned from one upstream message. */
export type Inspection =
  /** A data message that passed validation. `tsMs` is its event time. */
  | { kind: 'data'; type: string; events: number; tsMs: number; collector?: string }
  /** Protocol chatter: subscription confirmations, pongs. */
  | { kind: 'control' }
  /** The feed told us something is wrong (Atlas says so when it drops messages for us). */
  | { kind: 'warning'; text: string }
  /** Valid JSON that does not match the schema. */
  | { kind: 'invalid'; reason: string }
  /** Not JSON at all. */
  | { kind: 'unparseable' };

export interface StreamSpec {
  name: string;
  /** Human description of the subscription, for the report. */
  subscription: string;
  url: string;
  /** Write the raw messages to disk? */
  record: boolean;
  subscribe(ws: WebSocket): void;
  inspect(text: string): Inspection;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function inspectRis(text: string): Inspection {
  const json = parseJson(text);
  if (!json.ok) return { kind: 'unparseable' };

  const type = (json.value as { type?: unknown } | null)?.type;
  if (type === 'ris_error') return { kind: 'warning', text: text.slice(0, 300) };
  if (type !== 'ris_message') return { kind: 'control' };

  const parsed = risMessageSchema.safeParse(json.value);
  if (!parsed.success) return { kind: 'invalid', reason: parsed.error.issues[0]?.message ?? '?' };
  const { data } = parsed.data;
  return {
    kind: 'data',
    type: data.type,
    events: risEventCount(data),
    tsMs: Math.round(data.timestamp * 1000), // RIS sends seconds
    collector: data.host.replace('.ripe.net', ''),
  };
}

function inspectAtlas(text: string): Inspection {
  const json = parseJson(text);
  if (!json.ok) return { kind: 'unparseable' };

  const frame = atlasFrameSchema.safeParse(json.value);
  if (!frame.success) return { kind: 'invalid', reason: 'not an [event, payload] pair' };
  const [event, payload] = frame.data;

  if (event === 'atlas_result') {
    const parsed = atlasPingSchema.safeParse(payload);
    if (!parsed.success) return { kind: 'invalid', reason: parsed.error.issues[0]?.message ?? '?' };
    return { kind: 'data', type: 'ping', events: 1, tsMs: parsed.data.timestamp * 1000 };
  }
  if (event === 'atlas_probestatus') {
    const parsed = atlasProbeStatusSchema.safeParse(payload);
    if (!parsed.success) return { kind: 'invalid', reason: parsed.error.issues[0]?.message ?? '?' };
    return {
      kind: 'data',
      type: `probe_${parsed.data.event}`,
      events: 1,
      tsMs: parsed.data.timestamp * 1000,
    };
  }
  if (event === 'atlas_subscribed') return { kind: 'control' };
  // Anything else (atlas_error and friends) is the feed talking about itself.
  return { kind: 'warning', text: text.slice(0, 300) };
}

const risUrl = (client: string) =>
  `wss://ris-live.ripe.net/v1/ws/?client=${encodeURIComponent(client)}`;

export function buildStreams(opts: {
  client: string;
  risHost: string;
  atlasMsms: number[];
  record: boolean;
}): StreamSpec[] {
  return [
    {
      name: 'ris-full',
      subscription: 'RIS Live, every collector, every message type',
      url: risUrl(opts.client),
      record: opts.record,
      subscribe: (ws) => ws.send(JSON.stringify({ type: 'ris_subscribe', data: {} })),
      inspect: inspectRis,
    },
    {
      // Measured only: it is a subset of ris-full, so recording it would duplicate data.
      name: 'ris-filtered',
      subscription: `RIS Live, collector ${opts.risHost} only, UPDATE messages only`,
      url: risUrl(opts.client),
      record: false,
      subscribe: (ws) =>
        ws.send(
          JSON.stringify({ type: 'ris_subscribe', data: { host: opts.risHost, type: 'UPDATE' } }),
        ),
      inspect: inspectRis,
    },
    {
      name: 'atlas',
      subscription: `RIPE Atlas, ping results of measurements ${opts.atlasMsms.join(', ')} plus probe status`,
      url: 'wss://atlas-stream.ripe.net/stream/',
      record: opts.record,
      subscribe: (ws) => {
        for (const msm of opts.atlasMsms) {
          ws.send(JSON.stringify(['atlas_subscribe', { streamType: 'result', msm }]));
        }
        ws.send(JSON.stringify(['atlas_subscribe', { streamType: 'probestatus' }]));
      },
      inspect: inspectAtlas,
    },
  ];
}
