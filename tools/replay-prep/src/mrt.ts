/*
 * A small reader for MRT files (RFC 6396), the format RIPE RIS uses to archive
 * BGP updates. It understands exactly what an "updates" file contains:
 *
 *   MRT record  = 12-byte header + body
 *   body        = BGP4MP header (who said it: peer AS and IP) + one BGP message
 *   BGP UPDATE  = withdrawn prefixes + path attributes + announced prefixes
 *
 * IPv4 prefixes sit directly in the UPDATE; IPv6 prefixes sit inside the
 * MP_REACH_NLRI / MP_UNREACH_NLRI attributes (RFC 4760).
 */

export interface MrtUpdate {
  kind: 'update';
  tsMs: number;
  peerAsn: number;
  peerIp: string;
  announced: string[];
  withdrawn: string[];
  /** Network that originates the announced prefixes (last AS of the path); null if unknown. */
  originAsn: number | null;
  /** Number of hops in the AS path (an AS set counts as one). */
  pathLen: number;
}

export interface MrtState {
  kind: 'state';
  tsMs: number;
  peerAsn: number;
  peerIp: string;
  oldState: number;
  newState: number;
}

export type MrtRecord = MrtUpdate | MrtState;

export interface MrtStats {
  records: number;
  updates: number;
  states: number;
  /** Records of a type we do not need (keepalives, opens, table dumps). */
  skipped: number;
  /** Records we could not decode. They are counted and skipped, never fatal. */
  malformed: number;
}

const MRT_BGP4MP = 16;
const MRT_BGP4MP_ET = 17; // same, plus a microsecond field

// BGP4MP subtypes
const STATE_CHANGE = 0;
const MESSAGE = 1;
const MESSAGE_AS4 = 4;
const STATE_CHANGE_AS4 = 5;
const MESSAGE_LOCAL = 6;
const MESSAGE_AS4_LOCAL = 7;
const MESSAGE_ADDPATH = 8;
const MESSAGE_AS4_ADDPATH = 9;
const MESSAGE_LOCAL_ADDPATH = 10;
const MESSAGE_AS4_LOCAL_ADDPATH = 11;

const AS4_SUBTYPES = new Set([
  MESSAGE_AS4,
  STATE_CHANGE_AS4,
  MESSAGE_AS4_LOCAL,
  MESSAGE_AS4_ADDPATH,
  MESSAGE_AS4_LOCAL_ADDPATH,
]);
const ADDPATH_SUBTYPES = new Set([
  MESSAGE_ADDPATH,
  MESSAGE_AS4_ADDPATH,
  MESSAGE_LOCAL_ADDPATH,
  MESSAGE_AS4_LOCAL_ADDPATH,
]);
const MESSAGE_SUBTYPES = new Set([
  MESSAGE,
  MESSAGE_AS4,
  MESSAGE_LOCAL,
  MESSAGE_AS4_LOCAL,
  ...ADDPATH_SUBTYPES,
]);

const BGP_UPDATE = 2;
const ATTR_AS_PATH = 2;
const ATTR_MP_REACH = 14;
const ATTR_MP_UNREACH = 15;
const ATTR_AS4_PATH = 17;
const AFI_IPV4 = 1;
const AFI_IPV6 = 2;
const SAFI_UNICAST = 1;
const AS_SEQUENCE = 2;

export function formatIpv4(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/** Format 16 bytes as IPv6 text, shortening the longest run of zero groups to "::". */
export function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);

  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }

  const hex = (from: number, to: number) =>
    groups
      .slice(from, to)
      .map((g) => g.toString(16))
      .join(':');
  if (bestLen < 2) return hex(0, 8);
  return `${hex(0, bestStart)}::${hex(bestStart + bestLen, 8)}`;
}

/**
 * Read a run of prefixes. Each is one byte giving the length in bits, followed
 * by just enough bytes to hold that many bits (so a /24 takes 3 bytes, not 4).
 */
function readPrefixes(
  buf: Buffer,
  start: number,
  end: number,
  afi: number,
  addPath: boolean,
  out: string[],
): void {
  const width = afi === AFI_IPV6 ? 16 : 4;
  let off = start;
  while (off < end) {
    if (addPath) off += 4; // path identifier, not needed
    const bits = buf[off]!;
    off += 1;
    const byteLen = (bits + 7) >> 3;
    if (bits > width * 8 || off + byteLen > end) throw new Error('bad prefix');
    const addr = new Uint8Array(width);
    addr.set(buf.subarray(off, off + byteLen));
    off += byteLen;
    out.push(`${afi === AFI_IPV6 ? formatIpv6(addr) : formatIpv4(addr)}/${bits}`);
  }
}

/** Read an AS path. Returns the origin (last AS, if the last segment is a sequence) and hop count. */
function readAsPath(
  buf: Buffer,
  start: number,
  end: number,
  asSize: 2 | 4,
): { origin: number | null; hops: number } {
  let off = start;
  let origin: number | null = null;
  let hops = 0;
  while (off + 2 <= end) {
    const segType = buf[off]!;
    const count = buf[off + 1]!;
    off += 2;
    if (off + count * asSize > end) throw new Error('bad AS path');
    if (segType === AS_SEQUENCE) {
      hops += count;
      if (count > 0) {
        const last = off + (count - 1) * asSize;
        origin = asSize === 4 ? buf.readUInt32BE(last) : buf.readUInt16BE(last);
      }
    } else {
      hops += 1; // an AS set counts as one hop and hides the single origin
      origin = null;
    }
    off += count * asSize;
  }
  return { origin, hops };
}

function parseUpdate(
  body: Buffer,
  off: number,
  as4: boolean,
  addPath: boolean,
): Pick<MrtUpdate, 'announced' | 'withdrawn' | 'originAsn' | 'pathLen'> | null {
  // BGP header: 16-byte marker, 2-byte length, 1-byte type.
  const msgLen = body.readUInt16BE(off + 16);
  const msgType = body[off + 18]!;
  if (msgType !== BGP_UPDATE) return null;
  const end = off + msgLen;
  if (end > body.length) throw new Error('truncated BGP message');
  off += 19;

  const announced: string[] = [];
  const withdrawn: string[] = [];
  let originAsn: number | null = null;
  let pathLen = 0;
  let as4Origin: number | null | undefined;

  const withdrawnLen = body.readUInt16BE(off);
  off += 2;
  readPrefixes(body, off, off + withdrawnLen, AFI_IPV4, addPath, withdrawn);
  off += withdrawnLen;

  const attrsLen = body.readUInt16BE(off);
  off += 2;
  const attrsEnd = off + attrsLen;
  if (attrsEnd > end) throw new Error('bad attribute length');

  while (off < attrsEnd) {
    const flags = body[off]!;
    const type = body[off + 1]!;
    // Bit 0x10 means the attribute length takes two bytes instead of one.
    const extended = (flags & 0x10) !== 0;
    const len = extended ? body.readUInt16BE(off + 2) : body[off + 2]!;
    const start = off + (extended ? 4 : 3);
    const stop = start + len;
    if (stop > attrsEnd) throw new Error('bad attribute');

    if (type === ATTR_AS_PATH) {
      const path = readAsPath(body, start, stop, as4 ? 4 : 2);
      originAsn = path.origin;
      pathLen = path.hops;
    } else if (type === ATTR_AS4_PATH) {
      // Old 2-byte speakers carry the real 4-byte path here.
      as4Origin = readAsPath(body, start, stop, 4).origin;
    } else if (type === ATTR_MP_REACH) {
      const afi = body.readUInt16BE(start);
      const safi = body[start + 2]!;
      const nextHopLen = body[start + 3]!;
      const nlri = start + 4 + nextHopLen + 1; // +1 reserved byte
      if (safi === SAFI_UNICAST && (afi === AFI_IPV4 || afi === AFI_IPV6)) {
        readPrefixes(body, nlri, stop, afi, addPath, announced);
      }
    } else if (type === ATTR_MP_UNREACH) {
      const afi = body.readUInt16BE(start);
      const safi = body[start + 2]!;
      if (safi === SAFI_UNICAST && (afi === AFI_IPV4 || afi === AFI_IPV6)) {
        readPrefixes(body, start + 3, stop, afi, addPath, withdrawn);
      }
    }
    off = stop;
  }

  // Whatever is left after the attributes is the list of announced IPv4 prefixes.
  readPrefixes(body, attrsEnd, end, AFI_IPV4, addPath, announced);

  if (!as4 && as4Origin !== undefined) originAsn = as4Origin;
  return { announced, withdrawn, originAsn, pathLen };
}

/** Decode every record of an (already gunzipped) MRT updates file. */
export function* parseMrt(buf: Buffer, stats: MrtStats): Generator<MrtRecord> {
  let off = 0;
  while (off + 12 <= buf.length) {
    const seconds = buf.readUInt32BE(off);
    const type = buf.readUInt16BE(off + 4);
    const subtype = buf.readUInt16BE(off + 6);
    const length = buf.readUInt32BE(off + 8);
    const bodyStart = off + 12;
    off = bodyStart + length; // always advance by the header's length, even if decoding fails
    if (off > buf.length) {
      stats.malformed += 1;
      return;
    }
    stats.records += 1;

    if (type !== MRT_BGP4MP && type !== MRT_BGP4MP_ET) {
      stats.skipped += 1;
      continue;
    }

    try {
      let p = bodyStart;
      let tsMs = seconds * 1000;
      if (type === MRT_BGP4MP_ET) {
        tsMs += Math.floor(buf.readUInt32BE(p) / 1000); // microseconds
        p += 4;
      }

      const isState = subtype === STATE_CHANGE || subtype === STATE_CHANGE_AS4;
      if (!isState && !MESSAGE_SUBTYPES.has(subtype)) {
        stats.skipped += 1;
        continue;
      }

      const as4 = AS4_SUBTYPES.has(subtype);
      const peerAsn = as4 ? buf.readUInt32BE(p) : buf.readUInt16BE(p);
      p += as4 ? 8 : 4; // peer AS + local AS
      p += 2; // interface index
      const afi = buf.readUInt16BE(p);
      p += 2;
      const ipLen = afi === AFI_IPV6 ? 16 : 4;
      const peerBytes = buf.subarray(p, p + ipLen);
      const peerIp = afi === AFI_IPV6 ? formatIpv6(peerBytes) : formatIpv4(peerBytes);
      p += ipLen * 2; // peer IP + local IP

      if (isState) {
        stats.states += 1;
        yield {
          kind: 'state',
          tsMs,
          peerAsn,
          peerIp,
          oldState: buf.readUInt16BE(p),
          newState: buf.readUInt16BE(p + 2),
        };
        continue;
      }

      const update = parseUpdate(buf.subarray(0, off), p, as4, ADDPATH_SUBTYPES.has(subtype));
      if (update === null) {
        stats.skipped += 1;
        continue;
      }
      stats.updates += 1;
      yield { kind: 'update', tsMs, peerAsn, peerIp, ...update };
    } catch {
      stats.malformed += 1;
    }
  }
}

export const emptyStats = (): MrtStats => ({
  records: 0,
  updates: 0,
  states: 0,
  skipped: 0,
  malformed: 0,
});
