/**
 * Network (ASN) to country, from the five Regional Internet Registries.
 *
 * Each registry publishes a daily "delegated-extended" file listing every
 * block of network numbers it has handed out and the country of the
 * organisation that holds it. That is the country a network is REGISTERED in,
 * not where its traffic flows; the UI labels it that way.
 *
 * A line looks like:  apnic|JP|asn|173|1|20020801|allocated|A91A4B1A
 *                     registry|country|type|first ASN|how many|date|status|id
 */

export const RIR_FILES = [
  'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
  'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
  'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
  'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
  'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
] as const;

export interface AsnRange {
  /** First ASN of the block. */
  start: number;
  /** How many consecutive ASNs the block holds. */
  count: number;
  /** Registration country (ISO 3166 alpha-2; the registries also use EU and AP). */
  cc: string;
}

/** Read the ASN blocks that are in use out of one delegated-extended file. */
export function parseDelegated(text: string): AsnRange[] {
  const out: AsnRange[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const f = line.split('|');
    if (f[2] !== 'asn') continue;
    const status = f[6];
    // "available" and "reserved" blocks belong to nobody yet.
    if (status !== 'allocated' && status !== 'assigned') continue;
    const cc = f[1] ?? '';
    if (!/^[A-Z]{2}$/.test(cc)) continue; // also skips the "*" summary lines
    const start = Number(f[3]);
    const count = Number(f[4]);
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1) continue;
    out.push({ start, count, cc });
  }
  return out;
}

/** Fast lookup over sorted, non-overlapping ranges (binary search). */
export class AsnCountryIndex {
  private readonly starts: Uint32Array;
  private readonly ends: Uint32Array;
  private readonly ccs: string[];

  constructor(ranges: AsnRange[]) {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    this.starts = new Uint32Array(sorted.length);
    this.ends = new Uint32Array(sorted.length);
    this.ccs = new Array<string>(sorted.length);
    sorted.forEach((r, i) => {
      this.starts[i] = r.start;
      this.ends[i] = r.start + r.count - 1;
      this.ccs[i] = r.cc;
    });
  }

  get size(): number {
    return this.starts.length;
  }

  lookup(asn: number): string | undefined {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! > asn) hi = mid - 1;
      else if (this.ends[mid]! < asn) lo = mid + 1;
      else return this.ccs[mid];
    }
    return undefined;
  }
}
