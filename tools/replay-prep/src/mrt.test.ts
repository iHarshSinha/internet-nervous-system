import { describe, expect, it } from 'vitest';
import { emptyStats, formatIpv6, parseMrt, type MrtRecord } from './mrt.ts';

// ---- helpers that build MRT bytes by hand, so the test does not depend on a download

const u8 = (...n: number[]) => Buffer.from(n);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const ipv6 = (hex: string) => Buffer.from(hex.replace(/:/g, ''), 'hex');

function attr(type: number, value: Buffer, extended = false): Buffer {
  return extended
    ? Buffer.concat([u8(0x90, type), u16(value.length), value])
    : Buffer.concat([u8(0x40, type, value.length), value]);
}

function bgpUpdate(withdrawn: Buffer, attrs: Buffer, nlri: Buffer): Buffer {
  const body = Buffer.concat([u16(withdrawn.length), withdrawn, u16(attrs.length), attrs, nlri]);
  return Buffer.concat([Buffer.alloc(16, 0xff), u16(19 + body.length), u8(2), body]);
}

/** BGP4MP_MESSAGE_AS4 (subtype 4) record from an IPv4 peer. */
function record(seconds: number, peerAsn: number, bgp: Buffer, subtype = 4): Buffer {
  const head =
    subtype === 4
      ? Buffer.concat([
          u32(peerAsn),
          u32(12654),
          u16(0),
          u16(1),
          u8(192, 0, 2, 1),
          u8(192, 0, 2, 2),
        ])
      : Buffer.concat([
          u16(peerAsn),
          u16(12654),
          u16(0),
          u16(1),
          u8(192, 0, 2, 1),
          u8(192, 0, 2, 2),
        ]);
  const body = Buffer.concat([head, bgp]);
  return Buffer.concat([u32(seconds), u16(16), u16(subtype), u32(body.length), body]);
}

const asPath4 = (...asns: number[]) => Buffer.concat([u8(2, asns.length), ...asns.map(u32)]);
const parseAll = (buf: Buffer) => {
  const stats = emptyStats();
  const records: MrtRecord[] = [...parseMrt(buf, stats)];
  return { records, stats };
};

describe('formatIpv6', () => {
  it('shortens the longest run of zeros', () => {
    expect(formatIpv6(ipv6('2a0f:1cc5:450c:0000:0000:0000:0000:0000'))).toBe('2a0f:1cc5:450c::');
    expect(formatIpv6(ipv6('2001:0db8:0000:0000:0001:0000:0000:0001'))).toBe('2001:db8::1:0:0:1');
    expect(formatIpv6(ipv6('0000:0000:0000:0000:0000:0000:0000:0000'))).toBe('::');
    expect(formatIpv6(ipv6('2001:0db8:0000:0001:0002:0003:0004:0005'))).toBe(
      '2001:db8:0:1:2:3:4:5',
    );
  });
});

describe('parseMrt', () => {
  it('reads IPv4 announcements and withdrawals with the origin network', () => {
    const bgp = bgpUpdate(
      u8(8, 10), // withdraw 10.0.0.0/8
      attr(2, asPath4(3356, 1299, 32934)),
      u8(24, 129, 134, 30, 22, 157, 240, 0), // announce 129.134.30.0/24 and 157.240.0.0/22
    );
    const { records, stats } = parseAll(record(1633361940, 3356, bgp));

    expect(stats).toMatchObject({ records: 1, updates: 1, malformed: 0 });
    expect(records).toEqual([
      {
        kind: 'update',
        tsMs: 1633361940000,
        peerAsn: 3356,
        peerIp: '192.0.2.1',
        announced: ['129.134.30.0/24', '157.240.0.0/22'],
        withdrawn: ['10.0.0.0/8'],
        originAsn: 32934,
        pathLen: 3,
      },
    ]);
  });

  it('reads IPv6 prefixes from the multiprotocol attributes', () => {
    const nextHop = ipv6('2001:0db8:0000:0000:0000:0000:0000:0001');
    const reach = Buffer.concat([
      u16(2),
      u8(1),
      u8(16),
      nextHop,
      u8(0),
      u8(48),
      ipv6('2a03:2880:f000'), // 2a03:2880:f000::/48
    ]);
    const unreach = Buffer.concat([u16(2), u8(1), u8(32), ipv6('2a03:2880')]); // 2a03:2880::/32
    const bgp = bgpUpdate(
      Buffer.alloc(0),
      Buffer.concat([attr(2, asPath4(6939, 32934)), attr(14, reach, true), attr(15, unreach)]),
      Buffer.alloc(0),
    );
    const [update] = parseAll(record(1633361941, 6939, bgp)).records;

    expect(update).toMatchObject({
      announced: ['2a03:2880:f000::/48'],
      withdrawn: ['2a03:2880::/32'],
      originAsn: 32934,
      pathLen: 2,
    });
  });

  it('handles 2-byte AS records and prefers the AS4_PATH origin', () => {
    const path2 = Buffer.concat([u8(2, 2), u16(3356), u16(23456)]); // 23456 = "AS_TRANS" placeholder
    const bgp = bgpUpdate(
      Buffer.alloc(0),
      Buffer.concat([attr(2, path2), attr(17, asPath4(3356, 396982))]),
      u8(24, 8, 8, 8),
    );
    const [update] = parseAll(record(1633361942, 3356, bgp, 1)).records;
    expect(update).toMatchObject({ peerAsn: 3356, originAsn: 396982, announced: ['8.8.8.0/24'] });
  });

  it('has no single origin when the path ends in an AS set', () => {
    const path = Buffer.concat([u8(2, 1), u32(3356), u8(1, 2), u32(64512), u32(64513)]);
    const bgp = bgpUpdate(Buffer.alloc(0), attr(2, path), u8(16, 172, 16));
    const [update] = parseAll(record(1633361943, 3356, bgp)).records;
    expect(update).toMatchObject({ originAsn: null, pathLen: 2 });
  });

  it('reads a peer state change', () => {
    const body = Buffer.concat([
      u32(3356),
      u32(12654),
      u16(0),
      u16(1),
      u8(192, 0, 2, 1),
      u8(192, 0, 2, 2),
      u16(6),
      u16(1),
    ]);
    const rec = Buffer.concat([u32(1633361944), u16(16), u16(5), u32(body.length), body]);
    expect(parseAll(rec).records).toEqual([
      {
        kind: 'state',
        tsMs: 1633361944000,
        peerAsn: 3356,
        peerIp: '192.0.2.1',
        oldState: 6,
        newState: 1,
      },
    ]);
  });

  it('counts a corrupt record and carries on with the next one', () => {
    const good = record(1633361945, 3356, bgpUpdate(u8(8, 10), Buffer.alloc(0), Buffer.alloc(0)));
    const corrupt = record(
      1633361945,
      3356,
      bgpUpdate(u8(99, 1, 2), Buffer.alloc(0), Buffer.alloc(0)),
    );
    const keepalive = record(
      1633361945,
      3356,
      Buffer.concat([Buffer.alloc(16, 0xff), u16(19), u8(4)]),
    );
    const tableDump = Buffer.concat([u32(1633361945), u16(13), u16(1), u32(2), u8(0, 0)]);

    const { records, stats } = parseAll(Buffer.concat([corrupt, keepalive, tableDump, good]));
    expect(records).toHaveLength(1);
    expect(stats).toEqual({ records: 4, updates: 1, states: 0, skipped: 2, malformed: 1 });
  });
});
