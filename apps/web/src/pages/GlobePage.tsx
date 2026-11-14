import { memo, useEffect, useState } from 'react';
import { AnimatedNumber } from '../components/AnimatedNumber.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { Starfield } from '../components/Starfield.tsx';
import { Welcome } from '../components/Welcome.tsx';
import { ReplayBadge } from '../components/Replay.tsx';
import { ScenarioBadge, ScenarioControls } from '../components/Scenario.tsx';
import { IncidentFeed } from '../components/Incidents.tsx';
import { RadarPanel } from '../components/Radar.tsx';
import { Panel, Stat } from '../components/ui.tsx';
import { countryName } from '../geo.ts';
import { GLOBE_HOME, GlobeView } from '../globe/GlobeView.tsx';
import { useGlobeSnapshots, useStatus } from '../hooks/snapshots.ts';
import { navigate } from '../router.ts';
import { useGlobe } from '../store/globe.ts';
import { useLive } from '../store/live.ts';
import { flyTo, selectCountry, useUi } from '../store/ui.ts';
import {
  BUCKET_COLORS,
  BUCKET_LABELS,
  flag,
  formatInt,
  healthColor,
  healthLabel,
} from '../theme.ts';

/** Re-read the globe store on a slow rhythm; it changes many times a second. */
function useGlobeTick(ms = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return useGlobe.getState();
}

const LivePulse = memo(function LivePulse() {
  const ann = useLive((s) => s.world.ann);
  const wd = useLive((s) => s.world.wd);
  const p50 = useLive((s) => s.world.p50);
  const countries = useLive((s) => s.world.countries);
  const changes = ann === undefined ? undefined : ann + (wd ?? 0);

  return (
    <Panel
      title="Pulse of the internet"
      aside={<span className="font-mono text-[0.78rem] text-low">last 2 min</span>}
    >
      <div className="flex items-end gap-2">
        <span className="font-mono text-[2.6rem] leading-none font-medium text-hi tabular-nums [text-shadow:0_0_28px_rgba(94,230,255,0.25)]">
          <AnimatedNumber value={changes} />
        </span>
        <span className="mb-1 text-xs text-mid">route changes / s</span>
      </div>
      <div className="mt-2 flex gap-3 text-[0.8rem]">
        <span className="text-signal">
          ● announced <AnimatedNumber value={ann} />
        </span>
        <span className="text-caution">
          ● withdrawn <AnimatedNumber value={wd} />
        </span>
      </div>
      <div className="-mx-1 mt-3">
        <Sparkline />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3">
        <Stat
          label="Median latency"
          value={typeof p50 === 'number' ? p50.toFixed(1) : '—'}
          unit="ms"
          hint="Median round trip from Atlas probes to the root DNS servers, latest minute"
        />
        <Stat label="Countries active" value={countries === undefined ? '—' : String(countries)} />
      </div>
    </Panel>
  );
});

/** Every upstream connection: is it up, how fast is it flowing, how far behind. */
const Sources = memo(function Sources() {
  const status = useStatus();
  const risEps = useLive((s) => s.sources.ris?.eps);
  const risLag = useLive((s) => s.sources.ris?.lag);
  const atlasEps = useLive((s) => s.sources.atlas?.eps);
  const upstreams = status.data?.upstreams ?? [];
  const label = (name: string) =>
    name.startsWith('ris:') ? `RIS ${name.slice(4)}` : name === 'atlas' ? 'Atlas stream' : name;

  return (
    <Panel
      title="Data sources"
      aside={
        <span className="font-mono text-[0.78rem] text-low">
          {upstreams.filter((u) => u.connected).length}/{upstreams.length || '—'} up
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md bg-white/[0.025] px-3 py-2">
          <div className="text-[0.72rem] tracking-[0.1em] text-low uppercase">Routing · RIS</div>
          <div className="mt-0.5 font-mono text-sm text-hi tabular-nums">
            <AnimatedNumber value={risEps} /> <span className="text-[0.76rem] text-mid">ev/s</span>
          </div>
          <div className="text-[0.74rem] text-low">
            {typeof risLag === 'number' ? `${risLag.toFixed(1)} s behind` : '—'}
          </div>
        </div>
        <div className="rounded-md bg-white/[0.025] px-3 py-2">
          <div className="text-[0.72rem] tracking-[0.1em] text-low uppercase">Latency · Atlas</div>
          <div className="mt-0.5 font-mono text-sm text-hi tabular-nums">
            <AnimatedNumber value={atlasEps} />{' '}
            <span className="text-[0.76rem] text-mid">ev/s</span>
          </div>
          <div className="text-[0.74rem] text-low">arrives 1–4 min late</div>
        </div>
      </div>
      <ul className="mt-3 space-y-1.5">
        {upstreams.map((u) => (
          <li key={u.name} className="flex items-center gap-2 text-[0.82rem]">
            <span
              className={`size-1.5 rounded-full ${u.connected ? 'bg-signal shadow-[0_0_8px_var(--color-signal)]' : 'bg-caution'}`}
            />
            <span className="flex-1 text-mid">{label(u.name)}</span>
            <span className="font-mono text-low tabular-nums">{formatInt(u.messages)}</span>
            {u.reconnects > 0 && (
              <span className="font-mono text-caution" title="Reconnects since start">
                ↻{u.reconnects}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
});

/** How the world's probes are doing right now, by latency bucket. */
const LatencyMix = memo(function LatencyMix() {
  const { probeBucket } = useGlobeTick(2000);
  const counts = BUCKET_COLORS.map(() => 0);
  for (const b of probeBucket.values()) if (b >= 0 && b < counts.length) counts[b]! += 1;
  const total = counts.reduce((a, b) => a + b, 0);

  return (
    <Panel
      title="Probe latency mix"
      aside={<span className="font-mono text-[0.78rem] text-low">{formatInt(total)} probes</span>}
    >
      <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.04]">
        {counts.map((n, i) => (
          <span
            key={BUCKET_LABELS[i]}
            className="h-full transition-[width] duration-700"
            style={{ width: total ? `${(n / total) * 100}%` : 0, background: BUCKET_COLORS[i] }}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {counts.map((n, i) => (
          <li key={BUCKET_LABELS[i]} className="flex items-center gap-1.5 text-[0.78rem]">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: BUCKET_COLORS[i] }}
            />
            <span className="truncate text-mid">{BUCKET_LABELS[i]}</span>
            <span className="ml-auto font-mono text-low tabular-nums">
              {total ? `${Math.round((n / total) * 100)}%` : '—'}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
});

const Busiest = memo(function Busiest() {
  const { countries } = useGlobeTick(1000);
  const rows = [...countries]
    .filter(([, c]) => (c.act ?? 0) > 0)
    .sort((a, b) => (b[1].act ?? 0) - (a[1].act ?? 0))
    .slice(0, 8);
  const max = Math.max(1, ...rows.map(([, c]) => c.act ?? 0));

  return (
    <Panel
      title="Busiest right now"
      aside={<span className="font-mono text-[0.78rem] text-low">changes / s</span>}
    >
      <ol className="space-y-0.5">
        {rows.length === 0 && (
          <li className="py-5 text-center text-sm text-low">Listening for routing changes…</li>
        )}
        {rows.map(([cc, c], i) => (
          <li key={cc}>
            <button
              type="button"
              onClick={() => selectCountry(cc)}
              className="group relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.05]"
            >
              <span
                className="absolute inset-y-1 left-0 rounded-r-md bg-gradient-to-r from-signal/[0.02] to-signal/[0.12] transition-[width] duration-700"
                style={{ width: `${((c.act ?? 0) / max) * 100}%` }}
              />
              <span className="relative w-3 font-mono text-[0.74rem] text-low">{i + 1}</span>
              <span className="relative text-base leading-none">{flag(cc)}</span>
              <span className="relative min-w-0 flex-1 truncate text-[0.92rem] text-hi">
                {countryName(cc)}
              </span>
              <span
                className="relative size-1.5 rounded-full"
                style={{ background: healthColor(c.h) }}
              />
              <span className="relative w-12 text-right font-mono text-xs text-mid tabular-nums">
                {formatInt(c.act ?? 0)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Panel>
  );
});

/** The countries in worst shape right now, from their latest closed minute. */
const TroubleSpots = memo(function TroubleSpots() {
  const { countries } = useGlobeTick(2000);
  const rows = [...countries]
    .filter(([, c]) => c.h !== undefined && c.h < 90)
    .sort((a, b) => (a[1].h ?? 100) - (b[1].h ?? 100))
    .slice(0, 5);

  return (
    <Panel
      title="Trouble spots"
      aside={<span className="font-mono text-[0.78rem] text-low">health below 90</span>}
    >
      {rows.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg bg-signal/[0.05] px-3 py-2 text-[0.86rem] text-mid">
          <span className="size-1.5 rounded-full bg-signal shadow-[0_0_10px_var(--color-signal)]" />
          All clear: every country is above 90
        </div>
      ) : (
        <ul className="space-y-0.5">
          {rows.map(([cc, c]) => (
            <li key={cc}>
              <button
                type="button"
                onClick={() => selectCountry(cc)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.05]"
              >
                <span className="text-base leading-none">{flag(cc)}</span>
                <span className="min-w-0 flex-1 truncate text-[0.92rem] text-hi">
                  {countryName(cc)}
                </span>
                <span className="text-[0.76rem]" style={{ color: healthColor(c.h) }}>
                  {healthLabel(c.h)}
                </span>
                <span
                  className="w-8 text-right font-mono text-sm tabular-nums"
                  style={{ color: healthColor(c.h) }}
                >
                  {c.h}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
});

/** Quick look at the country picked on the globe. */
function CountryCard() {
  const cc = useUi((s) => s.selected);
  const { countries, probePos } = useGlobeTick(1000);
  if (!cc) return null;
  const c = countries.get(cc);
  let probes = 0;
  for (const [, , pcc] of probePos.values()) if (pcc === cc) probes += 1;

  return (
    <div className="glass pointer-events-auto w-full animate-[rise_.45s_both] rounded-lg p-4 lg:w-[360px]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-3xl leading-none">{flag(cc)}</span>
          <div>
            <div className="text-lg font-semibold text-hi">{countryName(cc)}</div>
            <div className="text-[0.8rem] text-low">
              <span style={{ color: healthColor(c?.h) }}>{healthLabel(c?.h)}</span> ·{' '}
              {formatInt(probes)} Atlas probes here
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => selectCountry(null)}
          className="rounded-md px-2 text-low transition hover:text-hi"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Stat
          label="Health"
          value={c?.h === undefined ? '—' : String(c.h)}
          tone={healthColor(c?.h)}
        />
        <Stat label="Changes" value={c?.act === undefined ? '—' : formatInt(c.act)} unit="/ s" />
        <Stat
          label="Latency"
          value={typeof c?.p50 === 'number' ? c.p50.toFixed(0) : '—'}
          unit="ms"
        />
      </div>
      <button
        type="button"
        onClick={() => navigate(`/c/${cc}`)}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-signal/10 py-2.5 text-sm font-medium text-signal ring-1 ring-signal/30 transition hover:bg-signal/20"
      >
        Open live history <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}

const REGIONS: [string, number, number][] = [
  ['Americas', 15, -80],
  ['Europe', 50, 15],
  ['Africa', 4, 20],
  ['Asia', 30, 95],
  ['Oceania', -25, 140],
];

function RegionDock() {
  const go = (lat: number, lng: number, altitude?: number) => {
    selectCountry(null);
    flyTo(lat, lng, altitude);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {REGIONS.map(([name, lat, lng]) => (
        <button
          key={name}
          type="button"
          onClick={() => go(lat, lng)}
          className="rounded-full px-3 py-1 text-[0.82rem] text-mid ring-1 ring-white/[0.08] transition hover:bg-white/[0.06] hover:text-hi"
        >
          {name}
        </button>
      ))}
      <button
        type="button"
        onClick={() => go(GLOBE_HOME.lat, GLOBE_HOME.lng, GLOBE_HOME.altitude)}
        className="rounded-full px-3 py-1 text-[0.82rem] text-signal ring-1 ring-signal/25 transition hover:bg-signal/10"
      >
        ◎ Whole world
      </button>
    </div>
  );
}

const PipelineStrip = memo(function PipelineStrip() {
  const seq = useLive((s) => s.seq);
  const delayMs = useLive((s) => s.delayMs);
  const dup = useLive((s) => s.pipe.dup);
  const late = useLive((s) => s.pipe.late);
  const future = useLive((s) => s.pipe.future);
  const prefixes = useLive((s) => s.pipe.prefixes);
  const gaps = useLive((s) => s.stats.gaps);
  const n = (v: number | undefined) => (v === undefined ? '—' : formatInt(v));
  const item = (k: string, v: string, hint: string) => (
    <span className="whitespace-nowrap" title={hint}>
      <span className="text-low">{k}</span> <span className="text-mid tabular-nums">{v}</span>
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.76rem]">
      {item('frame', seq === 0 ? '—' : `#${seq}`, 'Sequence number of the latest world frame')}
      {item('delivery', delayMs === null ? '—' : `${delayMs} ms`, 'Server stamp to this page')}
      {item('gaps', String(gaps), 'Missing frames (recovered with resync)')}
      {item('dupes dropped', n(dup), 'Events seen twice and dropped')}
      {item('late', n(late), 'Events that arrived after their minute closed')}
      {item('future-dated', n(future), 'Events stamped ahead of our clock, set aside')}
      {item('prefixes', n(prefixes), 'Address blocks whose owner we know')}
    </div>
  );
});

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.78rem] text-mid">
      <span className="flex items-center gap-2">
        <span className="tracking-[0.1em] text-low uppercase">Land</span>
        <span
          className="h-1.5 w-20 rounded-full"
          style={{
            background: `linear-gradient(90deg, ${healthColor(10)}, ${healthColor(40)}, ${healthColor(75)}, ${healthColor(100)})`,
          }}
        />
        <span>health</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="tracking-[0.1em] text-low uppercase">Dots</span>
        <span className="flex gap-0.5">
          {BUCKET_COLORS.map((c) => (
            <span key={c} className="size-1.5 rounded-full" style={{ background: c }} />
          ))}
        </span>
        <span>probe latency</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="size-3 rounded-full border border-signal/70" />
        <span>busy routing</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="h-0.5 w-5 rounded-full bg-gradient-to-r from-critical/10 to-[#ff8c6e]" />
        <span>attack corridors</span>
      </span>
    </div>
  );
}

export function GlobePage() {
  useGlobeSnapshots();
  // Leaving the page forgets the selection.
  useEffect(() => () => selectCountry(null), []);

  return (
    <main className="relative min-h-dvh overflow-hidden">
      <div className="fixed inset-0 bg-[radial-gradient(110%_75%_at_50%_45%,#1a3558_0%,#0d1a2d_45%,#0a1321_70%)]" />
      <div className="fixed inset-0 opacity-70">
        <Starfield />
      </div>
      <div className="fixed inset-0 max-lg:relative max-lg:h-[62vh]">
        <GlobeView />
      </div>
      {/* Edge vignette, so the panels sit on darkness rather than on the globe. */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(75%_70%_at_50%_50%,transparent_55%,rgba(10,19,33,0.78)_100%)] max-lg:hidden" />

      {/* Greeting (signed in) or an invitation to sign in, top centre. */}
      <div className="pointer-events-none relative z-20 flex justify-center px-4 pt-3 lg:fixed lg:inset-x-0 lg:top-20 lg:pt-0">
        <div className="flex flex-col items-center gap-2">
          <ScenarioBadge />
          <ReplayBadge />
          <Welcome />
        </div>
      </div>

      {/* On large screens everything fits one screen: two scrolling rails and the legend dock. */}
      <div className="pointer-events-none relative z-10 flex flex-col gap-4 px-4 pb-4 sm:px-7 sm:pb-5 lg:h-dvh lg:pt-20">
        <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row lg:items-stretch lg:justify-between">
          <div className="pointer-events-auto flex w-full flex-col gap-3 lg:rail lg:w-[300px] 2xl:w-[340px]">
            <div className="animate-[rise_.9s_.15s_both]">
              <LivePulse />
            </div>
            <div className="animate-[rise_.9s_.3s_both]">
              <Sources />
            </div>
            <div className="animate-[rise_.9s_.45s_both]">
              <RadarPanel />
            </div>
            <ScenarioControls />
          </div>

          <div className="lg:hidden">
            <CountryCard />
          </div>

          <div className="pointer-events-auto flex w-full flex-col gap-3 lg:rail lg:w-[300px] 2xl:w-[340px]">
            <div className="animate-[rise_.9s_.2s_both]">
              <IncidentFeed />
            </div>
            <div className="animate-[rise_.9s_.25s_both]">
              <Busiest />
            </div>
            <div className="animate-[rise_.9s_.4s_both]">
              <TroubleSpots />
            </div>
            <div className="animate-[rise_.9s_.55s_both]">
              <LatencyMix />
            </div>
          </div>
        </div>

        <div className="pointer-events-none fixed inset-x-0 bottom-32 z-20 hidden justify-center lg:flex">
          <CountryCard />
        </div>

        <div className="glass pointer-events-auto shrink-0 animate-[rise_.9s_.6s_both] rounded-lg px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <Legend />
            <RegionDock />
          </div>
          <div className="mt-2.5 flex flex-col gap-1 border-t border-line pt-2.5 lg:flex-row lg:items-center lg:justify-between">
            <PipelineStrip />
            <span className="text-[0.74rem] text-low">
              Data: RIPE NCC (RIS, Atlas) · Cloudflare Radar (CC BY-NC 4.0) · Shapes: Natural Earth
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}
