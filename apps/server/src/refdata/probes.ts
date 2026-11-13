import { z } from 'zod';

/** What we keep about one RIPE Atlas probe. */
export interface ProbeInfo {
  id: number;
  /** Country where the probe physically is (set by its host). */
  cc?: string;
  /** Network the probe sits in (IPv4, else IPv6). */
  asn?: number;
  lat?: number;
  lon?: number;
  /** "Connected", "Disconnected", ... */
  status: string;
}

const PAGE_SIZE = 500;
const FIELDS = 'id,country_code,asn_v4,asn_v6,geometry,status';
/** Connected and disconnected probes; never-connected and abandoned ones are left out. */
const BASE = `https://atlas.ripe.net/api/v2/probes/?status__in=1,2&page_size=${PAGE_SIZE}&fields=${FIELDS}`;

const probeSchema = z.looseObject({
  id: z.number().int(),
  country_code: z.string().nullable().optional(),
  asn_v4: z.number().int().nullable().optional(),
  asn_v6: z.number().int().nullable().optional(),
  geometry: z
    .looseObject({ coordinates: z.tuple([z.number(), z.number()]) })
    .nullable()
    .optional(),
  status: z.looseObject({ name: z.string() }),
});

const pageSchema = z.looseObject({
  count: z.number().int(),
  results: z.array(z.unknown()),
});

export function toProbeInfo(raw: unknown): ProbeInfo | null {
  const parsed = probeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const cc = p.country_code?.toUpperCase();
  const asn = p.asn_v4 ?? p.asn_v6 ?? undefined;
  const [lon, lat] = p.geometry?.coordinates ?? [];
  return {
    id: p.id,
    status: p.status.name,
    ...(cc && /^[A-Z]{2}$/.test(cc) && { cc }),
    ...(asn !== undefined && { asn }),
    ...(lat !== undefined && lon !== undefined && { lat, lon }),
  };
}

/**
 * Download every connected or disconnected probe (about 18,000, in pages of
 * 500). Pages are fetched four at a time to be quick without hammering the API.
 */
export async function fetchProbes(fetchFn: typeof fetch = fetch): Promise<ProbeInfo[]> {
  const getPage = async (page: number) => {
    const res = await fetchFn(`${BASE}&page=${page}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Atlas probes API answered HTTP ${res.status}`);
    return pageSchema.parse(await res.json());
  };

  const first = await getPage(1);
  const pages = Math.ceil(first.count / PAGE_SIZE);
  const results = [...first.results];

  const remaining = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2);
  while (remaining.length > 0) {
    const batch = remaining.splice(0, 4);
    for (const page of await Promise.all(batch.map(getPage))) results.push(...page.results);
  }

  return results.map(toProbeInfo).filter((p): p is ProbeInfo => p !== null);
}
