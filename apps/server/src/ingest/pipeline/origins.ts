/**
 * Remembers which network originates each prefix, learned from announcements.
 *
 * A BGP withdrawal names only the prefix, not its owner. To say "AS32934
 * withdrew 300 routes" we must already know those prefixes belonged to
 * AS32934, and this table is that memory. The origin-change (hijack) detector
 * will read the same table in Phase 2.
 *
 * The whole internet is about 1.2 million prefixes. The table is capped so a
 * flood of bogus announcements cannot grow it without limit; once full, new
 * prefixes are not learned and that is counted.
 */
export class OriginTable {
  /** Announcements for unknown prefixes that were not stored because the table is full. */
  skipped = 0;
  private readonly origins = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1_500_000) {
    this.maxEntries = maxEntries;
  }

  learn(prefix: string, asn: number): void {
    if (this.origins.size >= this.maxEntries && !this.origins.has(prefix)) {
      this.skipped += 1;
      return;
    }
    this.origins.set(prefix, asn);
  }

  originOf(prefix: string): number | undefined {
    return this.origins.get(prefix);
  }

  get size(): number {
    return this.origins.size;
  }
}
