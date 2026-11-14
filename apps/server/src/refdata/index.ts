import type { Db } from 'mongodb';
import type { Logger } from '../logger.ts';
import { fetchProbes, type ProbeInfo } from './probes.ts';
import { AsnCountryIndex, parseDelegated, RIR_FILES, type AsnRange } from './rir.ts';

const DAY = 24 * 3600_000;
/** Registries change slowly; probes move and come and go every day. */
const ASN_MAX_AGE = 7 * DAY;
const PROBE_MAX_AGE = DAY;

/**
 * Reference data the pipeline needs to put events on the map:
 *  - which country a network is registered in;
 *  - where each Atlas probe is and which network it sits in.
 *
 * Lookups are in memory and synchronous, so the pipeline never waits on them.
 * Until the data has loaded they return undefined, and events simply do not
 * get a country scope yet.
 */
export class RefData {
  private asns = new AsnCountryIndex([]);
  private probes = new Map<number, ProbeInfo>();
  private ranges: AsnRange[] = [];
  private readonly listeners: ((update: RefDataUpdate) => void)[] = [];

  asnCountry(asn: number): string | undefined {
    return this.asns.lookup(asn);
  }

  probe(id: number): ProbeInfo | undefined {
    return this.probes.get(id);
  }

  allProbes(): Iterable<ProbeInfo> {
    return this.probes.values();
  }

  setAsnRanges(ranges: AsnRange[]): void {
    this.asns = new AsnCountryIndex(ranges);
    this.ranges = ranges;
    for (const l of this.listeners) l({ ranges });
  }

  setProbes(list: ProbeInfo[]): void {
    this.probes = new Map(list.map((p) => [p.id, p]));
    for (const l of this.listeners) l({ probes: list });
  }

  /**
   * Hear about every change, starting with what is loaded now. The ingest
   * thread keeps its own copy for its synchronous lookups.
   */
  subscribe(listener: (update: RefDataUpdate) => void): void {
    this.listeners.push(listener);
    const now: RefDataUpdate = {};
    if (this.ranges.length > 0) now.ranges = this.ranges;
    if (this.probes.size > 0) now.probes = [...this.probes.values()];
    if (now.ranges || now.probes) listener(now);
  }

  stats() {
    return { asnRanges: this.asns.size, probes: this.probes.size };
  }
}

export interface RefDataUpdate {
  ranges?: AsnRange[];
  probes?: ProbeInfo[];
}

interface MetaDoc {
  _id: string;
  asnsAt?: Date;
  probesAt?: Date;
}

/**
 * Keep `refdata` filled: load the copy cached in MongoDB at once, then
 * download fresh data in the background when the cache is missing or old, and
 * check again every hour. A failed download is logged and retried later; it
 * never stops the server.
 */
export function startRefdata(db: Db, refdata: RefData, log: Logger): () => void {
  const meta = db.collection<MetaDoc>('meta');
  const ranges = db.collection<{ _id: number; count: number; cc: string; gen: number }>(
    'asn_ranges',
  );
  const probes = db.collection<Omit<ProbeInfo, 'id'> & { _id: number; gen: number }>('probes');
  let running = false;

  async function loadCached(): Promise<MetaDoc | null> {
    const [m, cachedRanges, cachedProbes] = await Promise.all([
      meta.findOne({ _id: 'refdata' }),
      ranges.find().toArray(),
      probes.find().toArray(),
    ]);
    if (cachedRanges.length > 0) {
      refdata.setAsnRanges(cachedRanges.map((r) => ({ start: r._id, count: r.count, cc: r.cc })));
    }
    if (cachedProbes.length > 0) {
      refdata.setProbes(cachedProbes.map(({ _id, gen: _gen, ...rest }) => ({ id: _id, ...rest })));
    }
    log.info(refdata.stats(), 'reference data loaded from cache');
    return m;
  }

  async function refreshAsns(): Promise<void> {
    const texts = await Promise.all(
      RIR_FILES.map(async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
        return res.text();
      }),
    );
    const all = texts.flatMap(parseDelegated);
    refdata.setAsnRanges(all);

    // Replace the cache: upsert everything with a new generation number, then
    // delete whatever the new data no longer contains.
    const gen = Date.now();
    await ranges.bulkWrite(
      all.map((r) => ({
        replaceOne: {
          filter: { _id: r.start },
          replacement: { count: r.count, cc: r.cc, gen },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    await ranges.deleteMany({ gen: { $ne: gen } });
    await meta.updateOne({ _id: 'refdata' }, { $set: { asnsAt: new Date() } }, { upsert: true });
    log.info({ asnRanges: all.length }, 'network registration data refreshed');
  }

  async function refreshProbes(): Promise<void> {
    const list = await fetchProbes();
    refdata.setProbes(list);
    const gen = Date.now();
    await probes.bulkWrite(
      list.map(({ id, ...rest }) => ({
        replaceOne: { filter: { _id: id }, replacement: { ...rest, gen }, upsert: true },
      })),
      { ordered: false },
    );
    await probes.deleteMany({ gen: { $ne: gen } });
    await meta.updateOne({ _id: 'refdata' }, { $set: { probesAt: new Date() } }, { upsert: true });
    log.info({ probes: list.length }, 'Atlas probe data refreshed');
  }

  async function check(m: MetaDoc | null): Promise<void> {
    if (running) return;
    running = true;
    const now = Date.now();
    try {
      if (!m?.asnsAt || now - m.asnsAt.getTime() > ASN_MAX_AGE) {
        await refreshAsns().catch((err: unknown) =>
          log.warn({ err }, 'could not refresh network registration data; will retry'),
        );
      }
      if (!m?.probesAt || now - m.probesAt.getTime() > PROBE_MAX_AGE) {
        await refreshProbes().catch((err: unknown) =>
          log.warn({ err }, 'could not refresh Atlas probe data; will retry'),
        );
      }
    } finally {
      running = false;
    }
  }

  void loadCached()
    .catch((err: unknown) => {
      log.warn({ err }, 'could not read cached reference data');
      return null;
    })
    .then(check);

  const timer = setInterval(() => {
    void meta
      .findOne({ _id: 'refdata' })
      .then(check)
      .catch((err: unknown) => log.warn({ err }, 'reference data check failed'));
  }, 3600_000);

  return () => clearInterval(timer);
}
