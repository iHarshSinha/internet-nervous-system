/**
 * Remembers, for each prefix (block of addresses), which network originates
 * it and whether its latest update was a withdrawal.
 *
 * Two uses:
 *  - Attribution. A BGP withdrawal names only the prefix, not its owner. To
 *    say "AS32934 withdrew 300 routes" we must already know those prefixes
 *    belonged to AS32934.
 *  - Reachability. Per network we keep how many of its prefixes we know and
 *    how many are currently withdrawn. "Most of a network's prefixes are
 *    withdrawn" is how an outage looks after its storm has passed: silence.
 *
 * Each entry is one number, owner * 2 + withdrawnBit, so a million prefixes
 * cost about as much memory as a plain Map of numbers. The table is capped,
 * so a flood of bogus announcements cannot grow it without limit.
 */
export class OriginTable {
  /** Announcements for unknown prefixes that were not stored because the table is full. */
  skipped = 0;
  private readonly entries = new Map<string, number>();
  private readonly perAsn = new Map<number, { known: number; gone: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1_500_000) {
    this.maxEntries = maxEntries;
  }

  private counts(asn: number) {
    let c = this.perAsn.get(asn);
    if (!c) {
      c = { known: 0, gone: 0 };
      this.perAsn.set(asn, c);
    }
    return c;
  }

  /**
   * An announcement: `asn` originates `prefix` and it is reachable. Returns
   * the previous owner if the origin just changed (input for the hijack
   * detector), otherwise undefined.
   */
  learn(prefix: string, asn: number): number | undefined {
    const prev = this.entries.get(prefix);
    if (prev === undefined) {
      if (this.entries.size >= this.maxEntries) {
        this.skipped += 1;
        return undefined;
      }
      this.entries.set(prefix, asn * 2);
      this.counts(asn).known += 1;
      return undefined;
    }
    const prevAsn = Math.floor(prev / 2);
    const prevGone = prev % 2 === 1;
    this.entries.set(prefix, asn * 2);
    if (prevAsn === asn) {
      if (prevGone) this.counts(asn).gone -= 1;
      return undefined;
    }
    const old = this.counts(prevAsn);
    old.known -= 1;
    if (prevGone) old.gone -= 1;
    this.counts(asn).known += 1;
    return prevAsn;
  }

  /** A withdrawal: returns the owner (undefined if the prefix was never announced). */
  withdraw(prefix: string): number | undefined {
    const prev = this.entries.get(prefix);
    if (prev === undefined) return undefined;
    const asn = Math.floor(prev / 2);
    if (prev % 2 === 0) {
      this.entries.set(prefix, prev + 1);
      this.counts(asn).gone += 1;
    }
    return asn;
  }

  /** True if the prefix's latest update was a withdrawal. */
  isWithdrawn(prefix: string): boolean {
    return (this.entries.get(prefix) ?? 0) % 2 === 1;
  }

  originOf(prefix: string): number | undefined {
    const v = this.entries.get(prefix);
    return v === undefined ? undefined : Math.floor(v / 2);
  }

  /** How many of a network's prefixes we know, and how many are currently withdrawn. */
  reach(asn: number): { known: number; gone: number } {
    const c = this.perAsn.get(asn);
    return c ? { ...c } : { known: 0, gone: 0 };
  }

  /** Up to `limit` prefixes currently announced by a network (for the attack simulator). */
  prefixesOf(asn: number, limit: number): string[] {
    const out: string[] = [];
    const want = asn * 2; // owned and not withdrawn
    for (const [prefix, v] of this.entries) {
      if (v === want) {
        out.push(prefix);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Networks with the most known prefixes, optionally only those passing `keep`. */
  largest(n: number, keep: (asn: number) => boolean = () => true): number[] {
    return [...this.perAsn]
      .filter(([asn, c]) => c.known - c.gone > 0 && keep(asn))
      .sort((a, b) => b[1].known - b[1].gone - (a[1].known - a[1].gone))
      .slice(0, n)
      .map(([asn]) => asn);
  }

  get size(): number {
    return this.entries.size;
  }
}
