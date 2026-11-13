import type { CountriesResponse, ProbesResponse } from '@ins/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { loadCountryHealth, loadProbes } from '../store/globe.ts';

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Load the probe and country snapshots into the globe store, and refresh them
 * now and then. Live deltas in the world room keep them current in between.
 * Shared by every page through TanStack Query's cache, so it is fetched once.
 */
export function useGlobeSnapshots(): void {
  const probes = useQuery({
    queryKey: ['probes'],
    queryFn: () => getJson<ProbesResponse>('/api/probes'),
    refetchInterval: 5 * 60_000,
  });
  const countries = useQuery({
    queryKey: ['countries'],
    queryFn: () => getJson<CountriesResponse>('/api/countries'),
    refetchInterval: 60_000,
  });
  useEffect(() => {
    if (probes.data) loadProbes(probes.data);
  }, [probes.data]);
  useEffect(() => {
    if (countries.data) loadCountryHealth(countries.data);
  }, [countries.data]);
}

export interface StatusResponse {
  upstreams: { name: string; connected: boolean; reconnects: number; messages: number }[];
  refdata?: { asnRanges: number; probes: number };
}

/** Upstream connection details, polled (they change slowly). */
export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => getJson<StatusResponse>('/api/status'),
    refetchInterval: 5000,
  });
}
