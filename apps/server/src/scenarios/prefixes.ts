/**
 * A network's announced prefixes from RIPEstat. Used only by the attack
 * simulator when our live routing table (built from updates since the server
 * started) does not know the target well enough yet. Cached for an hour.
 */
const cache = new Map<number, { at: number; prefixes: string[] }>();

export async function fetchAnnouncedPrefixes(
  asn: number,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const hit = cache.get(asn);
  if (hit && Date.now() - hit.at < 3600_000) return hit.prefixes;
  const res = await fetchFn(
    `https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}&sourceapp=internet-nervous-system`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: { prefixes?: { prefix?: unknown }[] } };
  const prefixes = (body.data?.prefixes ?? [])
    .map((p) => p.prefix)
    .filter((p): p is string => typeof p === 'string' && p.length <= 49)
    .slice(0, 1000);
  cache.set(asn, { at: Date.now(), prefixes });
  return prefixes;
}
