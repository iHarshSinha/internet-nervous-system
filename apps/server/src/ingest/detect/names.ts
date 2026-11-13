import type { Db } from 'mongodb';
import type { Logger } from '../../logger.ts';

/**
 * Network names ("Facebook, Inc." for AS32934), from RIPEstat's as-overview,
 * fetched only when an incident needs one and cached in memory and MongoDB.
 */
export class AsnNames {
  private readonly names = new Map<number, string>();
  private readonly pending = new Set<number>();
  private readonly db: Db | null;
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;

  constructor(db: Db | null, log: Logger, fetchFn: typeof fetch = fetch) {
    this.db = db;
    this.log = log;
    this.fetchFn = fetchFn;
  }

  /** The name if known; otherwise null now, and a lookup starts in the background. */
  get(asn: number): string | null {
    const known = this.names.get(asn);
    if (known) return known;
    if (!this.pending.has(asn)) {
      this.pending.add(asn);
      void this.load(asn).finally(() => this.pending.delete(asn));
    }
    return null;
  }

  private async load(asn: number): Promise<void> {
    const cache = this.db?.collection<{ _id: number; name: string; at: Date }>('asn_names');
    try {
      const cached = await cache?.findOne({ _id: asn });
      if (cached) {
        this.names.set(asn, cached.name);
        return;
      }
      const res = await this.fetchFn(
        `https://stat.ripe.net/data/as-overview/data.json?resource=AS${asn}&sourceapp=internet-nervous-system`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { holder?: string } };
      const name = shortName(body.data?.holder ?? '');
      if (!name) return;
      this.names.set(asn, name);
      await cache?.replaceOne({ _id: asn }, { name, at: new Date() }, { upsert: true });
    } catch (err) {
      this.log.debug({ err, asn }, 'could not look up network name');
    }
  }
}

/** "FACEBOOK - Facebook, Inc., US" -> "Facebook, Inc."; "CLOUDFLARENET, US" -> "CLOUDFLARENET". */
export function shortName(holder: string): string {
  const afterDash = holder.includes(' - ') ? holder.slice(holder.indexOf(' - ') + 3) : holder;
  return afterDash.replace(/,\s*[A-Z]{2}$/, '').trim();
}
