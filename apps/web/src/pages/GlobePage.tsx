import type { CountriesResponse, ProbesResponse } from '@ins/shared';
import { useQuery } from '@tanstack/react-query';
import { memo, useEffect, useState } from 'react';
import { Sparkline } from '../components/Sparkline.tsx';
import { Starfield } from '../components/Starfield.tsx';
import { Panel, Stat } from '../components/ui.tsx';
import { countryName } from '../geo.ts';
import { GlobeView } from '../globe/GlobeView.tsx';
import { navigate } from '../router.ts';
import { loadCountryHealth, loadProbes, useGlobe } from '../store/globe.ts';
import { useLive } from '../store/live.ts';
import { BUCKET_COLORS, BUCKET_LABELS, colors, flag, formatInt, healthColor } from '../theme.ts';

const getJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
};

/** Load the probe and country snapshots once, and refresh them now and then. */
function useSnapshots() {
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

const LivePulse = memo(function LivePulse() {
  const ann = useLive((s) => s.world.ann);
  const wd = useLive((s) => s.world.wd);
  const p50 = useLive((s) => s.world.p50);
  const countries = useLive((s) => s.world.countries);
  const risEps = useLive((s) => s.sources.ris?.eps);
  const risLag = useLive((s) => s.sources.ris?.lag);
  const atlasEps = useLive((s) => s.sources.atlas?.eps);
  const up = useLive((s) => s.upstreamsUp);
  const total = useLive((s) => s.upstreams);
  const changes = ann === undefined ? undefined : ann + (wd ?? 0);

  return (
    <Panel
      title="Pulse of the internet"
      aside={<span className="font-mono text-[0.68rem] text-low">last 2 min</span>}
    >
      <div className="flex items-end gap-2">
        <span className="font-mono text-4xl font-medium text-hi tabular-nums">
          {changes === undefined ? '—' : formatInt(changes)}
        </span>
        <span className="mb-1.5 text-xs text-mid">route changes / s</span>
      </div>
      <div className="mt-1 flex gap-3 text-[0.7rem]">
        <span className="text-signal">● announced {ann === undefined ? '—' : formatInt(ann)}</span>
        <span className="text-caution">● withdrawn {wd === undefined ? '—' : formatInt(wd)}</span>
      </div>
      <div className="-mx-1 mt-3">
        <Sparkline />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4">
        <Stat
          label="Median latency"
          value={typeof p50 !== 'number' ? '—' : p50.toFixed(1)}
          unit="ms"
          hint="Median round trip from Atlas probes to the root DNS servers, latest minute"
        />
        <Stat label="Countries active" value={countries === undefined ? '—' : String(countries)} />
        <Stat
          label="Routing feed"
          value={risEps === undefined ? '—' : formatInt(risEps)}
          unit="ev/s"
          hint={`RIPE RIS, ${risLag ?? '—'} s behind real time`}
        />
        <Stat
          label="Latency feed"
          value={atlasEps === undefined ? '—' : formatInt(atlasEps)}
          unit="ev/s"
          hint="RIPE Atlas results per second"
        />
        <Stat
          label="Feeds up"
          value={total === null ? '—' : `${up ?? 0} / ${total}`}
          tone={up !== null && up === total ? colors.signal : colors.caution}
        />
        <Stat
          label="Feed delay"
          value={typeof risLag !== 'number' ? '—' : risLag.toFixed(1)}
          unit="s"
        />
      </div>
    </Panel>
  );
});

function useCountryRanking(limit: number) {
  const [rows, setRows] = useState<{ cc: string; act: number; h?: number }[]>([]);
  useEffect(() => {
    // Re-rank once a second at most; the store changes far more often.
    const timer = setInterval(() => {
      const list = [...useGlobe.getState().countries]
        .filter(([, c]) => (c.act ?? 0) > 0)
        .sort((a, b) => (b[1].act ?? 0) - (a[1].act ?? 0))
        .slice(0, limit)
        .map(([cc, c]) => ({ cc, act: c.act ?? 0, ...(c.h !== undefined && { h: c.h }) }));
      setRows(list);
    }, 1000);
    return () => clearInterval(timer);
  }, [limit]);
  return rows;
}

const CountryList = memo(function CountryList() {
  const rows = useCountryRanking(12);
  const max = Math.max(1, ...rows.map((r) => r.act));
  return (
    <Panel
      title="Busiest right now"
      aside={<span className="font-mono text-[0.68rem] text-low">changes / s</span>}
    >
      <ol className="space-y-1">
        {rows.length === 0 && (
          <li className="py-6 text-center text-sm text-low">Listening for routing changes…</li>
        )}
        {rows.map((r) => (
          <li key={r.cc}>
            <button
              type="button"
              onClick={() => navigate(`/c/${r.cc}`)}
              className="group relative flex w-full items-center gap-3 overflow-hidden rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.04]"
            >
              <span
                className="absolute inset-y-1 left-0 rounded-r-md bg-signal/[0.07] transition-[width] duration-700"
                style={{ width: `${(r.act / max) * 100}%` }}
              />
              <span className="relative text-base leading-none">{flag(r.cc)}</span>
              <span className="relative min-w-0 flex-1 truncate text-sm text-hi">
                {countryName(r.cc)}
              </span>
              <span
                className="relative size-1.5 rounded-full"
                style={{ background: healthColor(r.h) }}
                title={r.h === undefined ? 'health unknown' : `health ${r.h}`}
              />
              <span className="relative w-14 text-right font-mono text-xs text-mid tabular-nums">
                {formatInt(r.act)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Panel>
  );
});

const PipelineStrip = memo(function PipelineStrip() {
  const seq = useLive((s) => s.seq);
  const delayMs = useLive((s) => s.delayMs);
  const dup = useLive((s) => s.pipe.dup);
  const late = useLive((s) => s.pipe.late);
  const future = useLive((s) => s.pipe.future);
  const prefixes = useLive((s) => s.pipe.prefixes);
  const gaps = useLive((s) => s.stats.gaps);
  const item = (k: string, v: string) => (
    <span className="whitespace-nowrap">
      <span className="text-low">{k}</span> <span className="text-mid tabular-nums">{v}</span>
    </span>
  );
  const n = (v: number | undefined) => (v === undefined ? '—' : formatInt(v));
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[0.68rem]">
      {item('frame', seq === 0 ? '—' : `#${seq}`)}
      {item('delivery', delayMs === null ? '—' : `${delayMs} ms`)}
      {item('gaps', String(gaps))}
      {item('duplicates dropped', n(dup))}
      {item('late', n(late))}
      {item('future-dated', n(future))}
      {item('prefixes tracked', n(prefixes))}
    </div>
  );
});

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.68rem] text-mid">
      <span className="flex items-center gap-2">
        <span className="text-low uppercase tracking-[0.16em]">Land · health</span>
        <span
          className="h-1.5 w-24 rounded-full"
          style={{
            background: `linear-gradient(90deg, ${healthColor(10)}, ${healthColor(40)}, ${healthColor(75)}, ${healthColor(100)})`,
          }}
        />
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-low uppercase tracking-[0.16em]">Probes · latency</span>
        {BUCKET_LABELS.map((label, i) => (
          <span key={label} className="flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: BUCKET_COLORS[i] }} />
            {label}
          </span>
        ))}
      </span>
    </div>
  );
}

export function GlobePage() {
  useSnapshots();
  const probes = useGlobe((s) => s.probePos.size);

  return (
    <main className="relative min-h-dvh overflow-hidden">
      <div className="fixed inset-0 bg-[radial-gradient(120%_80%_at_50%_40%,#0b1a2a_0%,#04060b_60%)]" />
      <div className="fixed inset-0 opacity-70">
        <Starfield />
      </div>
      <div className="fixed inset-0 max-lg:relative max-lg:h-[62vh]">
        <GlobeView onCountryClick={(cc) => navigate(`/c/${cc}`)} />
      </div>

      <div className="pointer-events-none relative z-10 flex flex-col justify-between gap-4 px-4 pb-4 sm:px-7 sm:pb-6 lg:min-h-dvh lg:pt-24">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="pointer-events-auto w-full animate-[rise_.9s_.2s_both] lg:w-[300px]">
            <LivePulse />
          </div>
          <div className="pointer-events-auto w-full animate-[rise_.9s_.35s_both] lg:w-[290px]">
            <CountryList />
          </div>
        </div>

        <div className="pointer-events-auto glass animate-[rise_.9s_.5s_both] rounded-2xl px-4 py-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <Legend />
            <span className="text-[0.68rem] text-low">
              {probes > 0 ? `${formatInt(probes)} RIPE Atlas probes · ` : ''}routing from RIPE RIS ·
              click a country
            </span>
          </div>
          <div className="mt-2 border-t border-line pt-2">
            <PipelineStrip />
          </div>
        </div>
      </div>
    </main>
  );
}
