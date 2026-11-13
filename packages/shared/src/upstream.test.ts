import { describe, expect, it } from 'vitest';
import {
  atlasPingSchema,
  atlasProbeStatusSchema,
  risEventCount,
  risMessageSchema,
} from './index.ts';

// Real messages recorded on 13 Nov 2026, trimmed.
const risUpdate = {
  type: 'ris_message',
  data: {
    timestamp: 1794559322.51,
    peer: '2a00:1632::',
    peer_asn: '49544',
    id: '2a00:1632::-01a1d412298e0046',
    host: 'rrc25.ripe.net',
    type: 'UPDATE',
    path: [49544, 6939, 61049, 207841, 44324, 219378],
    community: [[6939, 1000]],
    origin: 'IGP',
    announcements: [{ next_hop: '2a00:1632::', prefixes: ['2a0f:1cc5:450c::/47'] }],
    withdrawals: [],
  },
};
const risState = {
  type: 'ris_message',
  data: {
    timestamp: 1794559325.53,
    peer: '2001:7f8:24::3c',
    peer_asn: '202194',
    id: '2001:7f8:24::3c-01a1d412355a0000',
    host: 'rrc20.ripe.net',
    type: 'STATE',
    state: 'down',
  },
};
const ping = {
  fw: 5130,
  af: 4,
  dst_addr: '199.7.83.42',
  result: [{ rtt: 102.06 }, { rtt: 101.78 }, { rtt: 101.72 }],
  rcvd: 3,
  sent: 3,
  min: 101.72,
  max: 102.06,
  avg: 101.85,
  msm_id: 1008,
  prb_id: 1011787,
  timestamp: 1794559291,
  type: 'ping',
};
const status = {
  timestamp: 1794559330,
  prb_id: 1015551,
  msm_id: 7000,
  type: 'connection',
  event: 'disconnect',
  controller: 'ctr-dub-sw02',
  asn: null,
  prefix: null,
};

describe('RIS Live messages', () => {
  it('accepts real UPDATE and STATE messages and keeps unknown fields', () => {
    const parsed = risMessageSchema.parse(risUpdate);
    expect(parsed.data.peer_asn).toBe('49544');
    expect(parsed.data).toHaveProperty('community');
    expect(risMessageSchema.safeParse(risState).success).toBe(true);
  });

  it('accepts an AS set inside a path', () => {
    const withSet = { ...risUpdate, data: { ...risUpdate.data, path: [1, [2, 3]] } };
    expect(risMessageSchema.safeParse(withSet).success).toBe(true);
  });

  it('rejects a message without an id or with an unknown type', () => {
    const { id: _id, ...noId } = risUpdate.data;
    expect(risMessageSchema.safeParse({ type: 'ris_message', data: noId }).success).toBe(false);
    const bad = { ...risUpdate, data: { ...risUpdate.data, type: 'NOPE' } };
    expect(risMessageSchema.safeParse(bad).success).toBe(false);
  });

  it('counts one event per prefix', () => {
    expect(risEventCount(risMessageSchema.parse(risUpdate).data)).toBe(1);
    expect(risEventCount(risMessageSchema.parse(risState).data)).toBe(1);
    const many = risMessageSchema.parse({
      ...risUpdate,
      data: {
        ...risUpdate.data,
        announcements: [
          { next_hop: 'a', prefixes: ['1.0.0.0/24', '1.0.1.0/24'] },
          { next_hop: 'b', prefixes: ['1.0.2.0/24'] },
        ],
        withdrawals: ['2.0.0.0/24', '2.0.1.0/24'],
      },
    });
    expect(risEventCount(many.data)).toBe(5);
  });
});

describe('RIPE Atlas messages', () => {
  it('accepts a real ping result and a probe status event', () => {
    expect(atlasPingSchema.safeParse(ping).success).toBe(true);
    expect(atlasProbeStatusSchema.safeParse(status).success).toBe(true);
  });

  it('accepts a ping that got no reply', () => {
    const lost = { ...ping, rcvd: 0, min: -1, avg: -1, max: -1 };
    expect(atlasPingSchema.safeParse(lost).success).toBe(true);
  });

  it('rejects a result without a probe id and an unknown status event', () => {
    const { prb_id: _p, ...noProbe } = ping;
    expect(atlasPingSchema.safeParse(noProbe).success).toBe(false);
    expect(atlasProbeStatusSchema.safeParse({ ...status, event: 'reboot' }).success).toBe(false);
  });
});
