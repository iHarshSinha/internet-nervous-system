import { memo, useEffect, useState, type ReactNode } from 'react';
import { AnimatedNumber } from '../components/AnimatedNumber.tsx';
import { CountrySearch } from '../components/CountrySearch.tsx';
import { IncidentFeed } from '../components/Incidents.tsx';
import { Popover } from '../components/Popover.tsx';
import { RadarPanel } from '../components/Radar.tsx';
import { ReplayBadge } from '../components/Replay.tsx';
import { ScenarioBadge, ScenarioControls } from '../components/Scenario.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { Starfield } from '../components/Starfield.tsx';
import { Panel, Stat } from '../components/ui.tsx';
import { Welcome } from '../components/Welcome.tsx';
import { Activity } from '../components/Wire.tsx';
import { countryName } from '../geo.ts';
import { GLOBE_HOME, GlobeView } from '../globe/GlobeView.tsx';
import { useFlip } from '../hooks/flip.ts';
import { useGlobeSnapshots, useStatus } from '../hooks/snapshots.ts';
import { navigate } from '../router.ts';
import { useGlobe } from '../store/globe.ts';
import { activeIncidents, useIncidents } from '../store/incidents.ts';
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
import { formatTime, useClockZone } from '../time.ts';

/** Re-read the globe store on a slow rhythm; it changes many times a second. */
function useGlobeTick(ms = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return useGlobe.getState();
}

/** The key numbers, always visible: the one card nobody has to open. */
const RightNow = memo(function RightNow() {
  const ann = useLive((s) => s.world.ann);
  const wd = useLive((s) => s.world.wd);
  const p50 = useLive((s) => s.world.p50);
  const countries = useLive((s) => s.world.countries);
  const second = useLive((s) => s.world.t);
  useClockZone((s) => s.local);
  const open = useIncidents((s) => activeIncidents(s.byId).length);
  const changes = ann === undefined ? undefined : ann + (wd ?? 0);

  return (
    <Panel
      title="Right now"
      aside={
        <span
          className="font-mono text-[0.8rem] text-low"
          title="The newest second that every route collector has delivered, so the count is complete. Collectors run a few seconds behind, more when one lags; late updates are added as they arrive."
        >
          {second ? `as of ${formatTime(second, true)}` : ''}
        </span>
      }
    >
      <div className="flex items-end gap-2">
        <span className="font-mono text-[2.9rem] leading-none text-hi tabular-nums">
          <AnimatedNumber value={changes} />
        </span>
        <span className="mb-1 text-[0.95rem] text-mid">route changes a second</span>
      </div>
      <div className="mt-1.5 flex gap-4 text-[0.9rem]">
        <span className="text-signal">
          announced <AnimatedNumber value={ann} />
        </span>
        <span className="text-caution">
          withdrawn <AnimatedNumber value={wd} />
        </span>
      </div>
      <div className="-mx-1 mt-3">
        <Sparkline height={48} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 border-t border-line pt-3">
        <Stat
          label="Latency"
          value={typeof p50 === 'number' ? p50.toFixed(0) : '—'}
          unit="ms"
          hint="Median round trip from RIPE Atlas probes to the root DNS servers, latest minute"
        />
        <Stat label="Countries" value={countries === undefined ? '—' : String(countries)} />
        <Stat
          label="Incidents"
          value={String(open)}
          tone={open > 0 ? '#ffb454' : undefined}
          hint="Open incidents, all over the world"
        />
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
      collapsible
      defaultOpen={false}
      id="sources"
      aside={
        <span className="font-mono text-[0.82rem] text-low">
          {upstreams.filter((u) => u.connected).length}/{upstreams.length || '—'} connected
        </span>
      }
    >
      <div className="divide-y divide-line/70">
        {(
          [
            [
              'Routing',
              'RIPE RIS',
              risEps,
              typeof risLag === 'number' ? `${risLag.toFixed(1)} s behind` : '—',
            ],
            ['Latency', 'RIPE Atlas', atlasEps, 'arrives 1–4 min late'],
          ] as const
        ).map(([name, source, eps, note]) => (
          <div key={name} className="flex items-baseline justify-between gap-3 py-2 first:pt-0">
            <div className="min-w-0">
              <div className="text-[0.95rem] text-hi">{name}</div>
              <div className="text-[0.76rem] text-low">
                {source} · {note}
              </div>
            </div>
            <div className="shrink-0 font-mono text-lg text-hi tabular-nums">
              <AnimatedNumber value={eps} />
              <span className="ml-1 text-[0.74rem] text-mid">/s</span>
            </div>
          </div>
        ))}
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
      title="Probe latency"
      collapsible
      defaultOpen={false}
      id="latency"
      aside={<span className="font-mono text-[0.82rem] text-low">{formatInt(total)} probes</span>}
      summary={
        <span className="font-mono text-[0.82rem] text-low">
          {total ? `${Math.round(((counts[0]! + counts[1]!) / total) * 100)}% under 50 ms` : '—'}
        </span>
      }
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
    .slice(0, 6);
  const max = Math.max(1, ...rows.map(([, c]) => c.act ?? 0));
  // Rows glide when the ranking changes.
  const list = useFlip<HTMLOListElement>([rows.map(([cc]) => cc).join()]);

  return (
    <Panel
      title="Busiest countries"
      collapsible
      id="busiest"
      aside={<span className="text-[0.86rem] text-low">per second</span>}
      summary={
        <span className="text-[0.86rem] text-low">
          {rows[0] ? `${flag(rows[0][0])} ${countryName(rows[0][0])} leads` : '—'}
        </span>
      }
    >
      <ol ref={list} className="relative space-y-0.5">
        {rows.length === 0 && (
          <li className="py-5 text-center text-sm text-low">Listening for routing changes…</li>
        )}
        {rows.map(([cc, c], i) => (
          <li key={cc} data-flip={cc}>
            <button
              type="button"
              onClick={() => selectCountry(cc)}
              className="group relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.05]"
            >
              <span
                className="absolute inset-y-1 left-0 rounded-r-md bg-white/[0.06] transition-[width] duration-700"
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
      collapsible
      defaultOpen={false}
      id="trouble"
      aside={<span className="text-[0.86rem] text-low">below 90</span>}
      summary={
        <span className={`text-[0.86rem] ${rows.length ? 'text-caution' : 'text-low'}`}>
          {rows.length ? `${rows.length} countr${rows.length === 1 ? 'y' : 'ies'}` : 'all clear'}
        </span>
      }
    >
      {rows.length === 0 ? (
        <p className="text-[0.92rem] text-mid">All clear: every country is above 90.</p>
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
    <div className="glass pointer-events-auto w-full animate-[rise_.45s_both] rounded-lg p-4 lg:w-[380px]">
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
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-hi py-2.5 text-[0.95rem] font-semibold text-void transition hover:bg-white"
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

/** Pick a region to fly to: a small menu instead of a row of buttons. */
function RegionMenu() {
  const [open, setOpen] = useState(false);
  const go = (lat: number, lng: number, altitude?: number) => {
    selectCountry(null);
    flyTo(lat, lng, altitude);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Fly to a region"
      button={
        <span className="flex items-center gap-2 px-3 text-[0.95rem] text-hi">
          Regions <span className="text-[0.7rem] text-low">▾</span>
        </span>
      }
    >
      <ul className="w-48 py-1">
        {REGIONS.map(([name, lat, lng]) => (
          <li key={name}>
            <button
              type="button"
              onClick={() => go(lat, lng)}
              className="w-full px-3 py-1.5 text-left text-[0.95rem] text-mid transition hover:bg-white/[0.06] hover:text-hi"
            >
              {name}
            </button>
          </li>
        ))}
        <li className="mt-1 border-t border-line pt-1">
          <button
            type="button"
            onClick={() => go(GLOBE_HOME.lat, GLOBE_HOME.lng, GLOBE_HOME.altitude)}
            className="w-full px-3 py-1.5 text-left text-[0.95rem] text-hi transition hover:bg-white/[0.06]"
          >
            Whole world
          </button>
        </li>
      </ul>
    </Popover>
  );
}

/** Pipeline numbers: interesting to engineers and judges, folded away for everyone else. */
const PipelineStats = memo(function PipelineStats() {
  const seq = useLive((s) => s.seq);
  const delayMs = useLive((s) => s.delayMs);
  const dup = useLive((s) => s.pipe.dup);
  const late = useLive((s) => s.pipe.late);
  const future = useLive((s) => s.pipe.future);
  const prefixes = useLive((s) => s.pipe.prefixes);
  const gaps = useLive((s) => s.stats.gaps);
  const queue = useLive((s) => s.queue);
  const n = (v: number | undefined) => (v === undefined ? '—' : formatInt(v));
  // Under load the server thins the raw feed, then sheds route announcements (counted).
  const pressure =
    queue.pressure === 'sampling'
      ? `sampling 1 in ${queue.sampleEvery ?? '?'}`
      : queue.pressure && queue.pressure !== 'normal'
        ? 'shedding'
        : null;
  const rows: [string, string, string][] = [
    ['Latest frame', seq === 0 ? '—' : `#${seq}`, 'Sequence number of the latest world frame'],
    [
      'Delivery',
      delayMs === null ? '—' : `${delayMs} ms`,
      'From the server stamping a frame to this page',
    ],
    ['Gaps', String(gaps), 'Missing frames, recovered with resync'],
    ['Duplicates dropped', n(dup), 'Events seen twice and dropped'],
    ['Late events', n(late), 'Events that arrived after their minute closed'],
    ['Future-dated', n(future), 'Events stamped ahead of our clock, set aside'],
    ['Prefixes known', n(prefixes), 'Address blocks whose owner we know'],
    [
      'Ingest queue',
      queue.fill === undefined ? '—' : `${Math.round(queue.fill * 100)}% full`,
      'Events waiting for the pipeline. Above 70% the raw feed is sampled; above 95% route announcements are shed',
    ],
    ['Shed under load', n(queue.shed), 'Events dropped by priority because the queue was full'],
  ];
  return (
    <Panel
      title="Pipeline"
      collapsible
      defaultOpen={false}
      id="pipeline"
      aside={
        pressure ? (
          <span className="rounded bg-caution/15 px-1.5 py-0.5 font-mono text-[0.78rem] text-caution">
            {pressure}
          </span>
        ) : (
          <span className="font-mono text-[0.82rem] text-low">
            {delayMs === null ? '—' : `${delayMs} ms`}
          </span>
        )
      }
    >
      <dl className="divide-y divide-line/70">
        {rows.map(([k, v, hint]) => (
          <div key={k} className="flex justify-between gap-3 py-1.5 text-[0.92rem]" title={hint}>
            <dt className="text-mid">{k}</dt>
            <dd className="font-mono text-hi tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        onClick={() => navigate('/ops')}
        className="mt-3 text-[0.9rem] text-signal hover:underline"
      >
        Performance page →
      </button>
    </Panel>
  );
});

/** "How to read the map", behind the ? button. */
function HelpPanel() {
  const [open, setOpen] = useState(false);
  const row = (key: ReactNode, text: string) => (
    <li className="flex gap-3">
      <span className="flex w-16 shrink-0 items-center justify-center pt-1">{key}</span>
      <span className="text-[0.95rem] leading-snug text-mid">{text}</span>
    </li>
  );
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="How to read the map"
      button={<span className="grid size-9 place-items-center text-lg text-hi">?</span>}
    >
      <div className="w-[min(380px,86vw)] p-4">
        <h3 className="title">How to read the map</h3>
        <ul className="mt-3 space-y-3">
          {row(
            <span
              className="h-2 w-14 rounded-full"
              style={{
                background: `linear-gradient(90deg, ${healthColor(10)}, ${healthColor(45)}, ${healthColor(75)}, ${healthColor(100)})`,
              }}
            />,
            'Land is coloured by each country’s network health, from disrupted to healthy.',
          )}
          {row(
            <span className="flex gap-0.5">
              {BUCKET_COLORS.map((c) => (
                <span key={c} className="size-1.5 rounded-full" style={{ background: c }} />
              ))}
            </span>,
            `Dots are RIPE Atlas probes, coloured by latency: ${BUCKET_LABELS.join(', ')}.`,
          )}
          {row(
            <span className="size-4 rounded-full border border-signal/80" />,
            'Ripples mark the countries where routes are changing most right now.',
          )}
          {row(
            <span className="size-4 rounded-full border-2 border-critical" />,
            'An icon is an open incident (red: critical, amber: warning, green: recovering); near the edge of the globe it is a pulsing dot. Hover for its name, click to read it. Each is marked real or simulated.',
          )}
          {row(
            <span className="h-0.5 w-12 rounded-full bg-gradient-to-r from-critical/10 to-[#ff8c6e]" />,
            'Arcs are real attack traffic between countries, as seen by Cloudflare over the last day. Cloudflare reports countries, not cities, so each arc ends at the country’s main internet hub (Ashburn for the US, Frankfurt for Germany).',
          )}
        </ul>
        <p className="mt-4 border-t border-line pt-3 text-[0.9rem] text-low">
          Drag to turn the globe, scroll to zoom, click a country for its numbers.
        </p>
        <p className="mt-2 text-[0.82rem] text-low">
          Data: RIPE NCC (RIS, Atlas), Cloudflare Radar (CC BY-NC 4.0). Shapes: Natural Earth.
        </p>
      </div>
    </Popover>
  );
}

export function GlobePage() {
  useGlobeSnapshots();
  // Leaving the page forgets the selection.
  useEffect(() => () => selectCountry(null), []);

  return (
    <main className="relative min-h-dvh [--side:400px] lg:h-dvh lg:overflow-hidden 2xl:[--side:440px]">
      <div className="fixed inset-0 bg-[radial-gradient(90%_80%_at_65%_50%,#1a1b1f_0%,#111214_50%,#0d0e10_80%)]" />
      <div className="fixed inset-0 opacity-50">
        <Starfield />
      </div>

      {/* The globe takes the right of the screen (the top, on phones). */}
      <div className="relative h-[min(58vh,110vw)] lg:fixed lg:inset-y-0 lg:right-0 lg:left-[var(--side)] lg:h-auto">
        <GlobeView />

        {/* The picked country, at the bottom of the globe. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 hidden justify-center px-4 lg:flex">
          <CountryCard />
        </div>

        {/* Map tools: few, quiet, in one corner. */}
        <div className="absolute right-4 bottom-4 z-30 flex items-center gap-2 sm:right-6 sm:bottom-6">
          <CountrySearch />
          <RegionMenu />
          <HelpPanel />
        </div>
      </div>

      {/* Everything to read, in one column on the left. */}
      <aside className="relative z-10 flex flex-col gap-3 px-4 pb-6 lg:rail lg:fixed lg:top-[4.6rem] lg:bottom-0 lg:left-0 lg:w-[var(--side)] lg:pt-1 lg:pr-0 lg:pl-5">
        {/* A simulation running: pinned to the top of the column while you scroll. */}
        <div className="sticky top-0 z-20 flex flex-col gap-2 empty:hidden">
          <ScenarioBadge />
          <ReplayBadge />
        </div>
        <div className="lg:hidden">
          <CountryCard />
        </div>
        <Welcome />
        <RightNow />
        <IncidentFeed />
        <Busiest />
        <TroubleSpots />

        <div className="mt-2 flex items-center gap-3 px-1">
          <span className="title text-low">More detail</span>
          <span className="h-px flex-1 bg-line" />
        </div>
        <Activity />
        <RadarPanel />
        <LatencyMix />
        <Sources />
        <PipelineStats />
        <ScenarioControls />
      </aside>
    </main>
  );
}
