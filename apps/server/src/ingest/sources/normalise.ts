import {
  ENVELOPE_VERSION,
  makeEid,
  type AtlasPing,
  type AtlasProbeStatus,
  type EventEnvelope,
  type RisData,
} from '@ins/shared';

/*
 * Pure functions that turn one upstream message into events in our envelope.
 * No I/O and no clock: `receivedAt` is passed in, so they are easy to test.
 */

/**
 * One RIS UPDATE becomes one event per prefix (`#0`, `#1`, ...), withdrawals
 * first. Other message types (keepalives, opens) carry nothing we use.
 */
export function normaliseRis(data: RisData, receivedAt: number): EventEnvelope[] {
  if (data.type !== 'UPDATE') return [];

  const ts = Math.round(data.timestamp * 1000); // RIS sends seconds
  const collector = data.host.replace('.ripe.net', '');
  const peerAsn = Number(data.peer_asn);
  const base = { v: ENVELOPE_VERSION, src: 'ris', ts, its: receivedAt } as const;
  const events: EventEnvelope[] = [];
  let part = 0;

  // A withdrawal names only the prefix. Who owned it is worked out later,
  // from announcements the pipeline has already seen.
  for (const prefix of data.withdrawals ?? []) {
    events.push({
      ...base,
      eid: makeEid('ris', data.id, part++),
      kind: 'bgp.withdraw',
      entity: { prefix, collector },
      data: { peerAsn, peer: data.peer },
    });
  }

  // The origin network is the last hop of the path. If the path ends in an AS
  // set (a nested array) there is no single origin, so we leave it out.
  const path = data.path ?? [];
  const last = path.at(-1);
  const origin = typeof last === 'number' ? last : undefined;
  const flat = path.flat();

  for (const announcement of data.announcements ?? []) {
    for (const prefix of announcement.prefixes) {
      events.push({
        ...base,
        eid: makeEid('ris', data.id, part++),
        kind: 'bgp.announce',
        entity: { prefix, collector, ...(origin !== undefined && { asn: origin }) },
        // The path lets the hijack detector see whether the old owner is still on the route.
        data: { peerAsn, peer: data.peer, pathLen: path.length, path: flat },
      });
    }
  }
  return events;
}

/** One ping result from one probe. `rtt` is null when no packet came back. */
export function normaliseAtlasPing(ping: AtlasPing, receivedAt: number): EventEnvelope {
  return {
    v: ENVELOPE_VERSION,
    src: 'atlas',
    // The dedupe key the plan names: measurement, probe and the probe's own timestamp.
    eid: makeEid('atlas', `${ping.msm_id}-${ping.prb_id}-${ping.timestamp}`),
    kind: 'atlas.ping',
    ts: ping.timestamp * 1000,
    its: receivedAt,
    entity: { probeId: ping.prb_id, msmId: ping.msm_id },
    data: {
      rtt: ping.rcvd > 0 && ping.avg >= 0 ? ping.avg : null,
      sent: ping.sent,
      rcvd: ping.rcvd,
      ...(ping.af !== undefined && { af: ping.af }),
    },
  };
}

/** A probe connecting to or disconnecting from the Atlas network. */
export function normaliseAtlasStatus(status: AtlasProbeStatus, receivedAt: number): EventEnvelope {
  return {
    v: ENVELOPE_VERSION,
    src: 'atlas',
    eid: makeEid('atlas', `status-${status.prb_id}-${status.timestamp}-${status.event}`),
    kind: 'atlas.probe_status',
    ts: status.timestamp * 1000,
    its: receivedAt,
    entity: {
      probeId: status.prb_id,
      ...(typeof status.asn === 'number' && status.asn >= 0 && { asn: status.asn }),
    },
    data: { event: status.event },
  };
}
