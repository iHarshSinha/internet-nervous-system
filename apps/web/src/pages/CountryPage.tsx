import { rooms, type HistoryResponse } from '@ins/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { HealthStrip } from '../charts/HealthStrip.tsx';
import { columns, TimeChart } from '../charts/TimeChart.tsx';
import { CountryMap } from '../components/CountryMap.tsx';
import { HealthGauge } from '../components/HealthGauge.tsx';
import { CountryIncidents } from '../components/Incidents.tsx';
import { MiniSpark } from '../components/MiniSpark.tsx';
import { WatchButton } from '../components/WatchButton.tsx';
import { Panel } from '../components/ui.tsx';
import { countryName, loadCountries } from '../geo.ts';
import { useGlobeSnapshots } from '../hooks/snapshots.ts';
import { subscribe, unsubscribe } from '../realtime/client.ts';
import { navigate } from '../router.ts';
import { useGlobe } from '../store/globe.ts';
import { useLive } from '../store/live.ts';
import { closeSeries, getSeries, loadHistory, openSeries, useSeries } from '../store/series.ts';
import { BUCKET_COLORS, BUCKET_LABELS, colors, flag, formatInt, healthColor } from '../theme.ts';

const DAY = 24 * 3600_000;

/**
 * Join the country's room, THEN load its history, then merge the two: the
 * order the protocol needs (join -> buffer -> history -> drop up to
 * snapshotSeq -> apply the rest).
 */
function useCountryRoom(cc: string) {
  const room = rooms.country(cc);
  const [joinedAt, setJoinedAt] = useState<number | null>(null);

  useEffect(() => {
    openSeries(room);
    let alive = true;
    void subscribe([room]).then(() => alive && setJoinedAt(Date.now()));
    return () => {
      alive = false;
      unsubscribe([room]);
      closeSeries(room);
      setJoinedAt(null);
    };
  }, [room]);

  const history = useQuery({
    queryKey: ['history', room, joinedAt],
    queryFn: async () => {
      const res = await fetch(`/api/history?scope=country&key=${cc}&from=${Date.now() - DAY}`);
      if (!res.ok) throw new Error(`history: HTTP ${res.status}`);
      return (await res.json()) as HistoryResponse;
    },
    enabled: joinedAt !== null,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (history.data) loadHistory(history.data);
  }, [history.data]);

  return { room, loading: history.isPending, error: history.error };
}

/** Re-read the room's series a few times a second for the numbers (charts stream on their own). */
function useSnapshot(room: string) {
  const version = useSeries((s) => s.version);
  const [snap, setSnap] = useState(() => summarise(room));
  useEffect(() => {
    const id = setTimeout(() => setSnap(summarise(room)), 250);
    return () => clearTimeout(id);
  }, [room, version]);
  return snap;
}

function summarise(room: string) {
  const s = getSeries(room);
  if (!s) return null;
  const secs = [...s.seconds.entries()].sort((a, b) => a[0] - b[0]);
  const mins = [...s.minutes.entries()].sort((a, b) => a[0] - b[0]);
  const lastMinutes = mins.slice(-60).map(([, p]) => p);
  const lastSecond = secs.at(-1)?.[1];
  const lastRouting = [...mins].reverse().find(([, p]) => p.ann !== undefined)?.[1];
  const lastLatency = [...mins].reverse().find(([, p]) => typeof p.p50 === 'number')?.[1];
  return {
    health: s.health,
    perSecond: lastSecond ? (lastSecond.ann ?? 0) + (lastSecond.wd ?? 0) : undefined,
    withdrawnLastMinute: lastRouting?.wd,
    p50: typeof lastLatency?.p50 === 'number' ? lastLatency.p50 : undefined,
    probes: lastLatency?.up,
    spark: {
      perSecond: secs.slice(-120).map(([, p]) => (p.ann ?? 0) + (p.wd ?? 0)),
      withdrawn: lastMinutes.map((p) => p.wd),
      p50: lastMinutes.map((p) => p.p50),
      probes: lastMinutes.map((p) => p.up),
    },
    seconds: s.seconds.size,
    minutes: s.minutes.size,
    snapshotSeq: s.snapshotSeq,
    lastSeq: s.lastSeq,
    dropped: s.droppedBySnapshot,
  };
}

/** True on wide screens, where charts get taller. */
function useWide(): boolean {
  const query = '(min-width: 1536px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

function Kpi({
  label,
  value,
  unit,
  spark,
  color,
  hint,
  delay = 0,
  tall = false,
}: {
  delay?: number;
  tall?: boolean;
  label: string;
  value: string;
  unit?: string;
  spark: (number | null | undefined)[];
  color: string;
  hint: string;
}) {
  return (
    <div
      className="flex flex-col rounded-xl bg-white/[0.025] p-3 ring-1 ring-white/[0.04] transition hover:ring-white/[0.1] 2xl:p-4"
      title={hint}
      style={{ animation: `rise .7s cubic-bezier(.2,.8,.2,1) ${delay}s both` }}
    >
      <div className="text-[0.62rem] tracking-[0.16em] text-low uppercase">{label}</div>
      <div className="mt-1 font-mono text-xl text-hi tabular-nums">
        {value}
        {unit && <span className="ml-1 text-xs text-mid">{unit}</span>}
      </div>
      {/* The trend line takes whatever height the tile has, so tall layouts fill up. */}
      <div className="mt-auto pt-2 opacity-90">
        <MiniSpark values={spark} color={color} height={tall ? 56 : 28} />
      </div>
    </div>
  );
}

function SeriesKey({ items }: { items: [string, string][] }) {
  return (
    <span className="flex gap-3 text-[0.68rem] text-mid">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded" style={{ background: color }} />
          {label}
        </span>
      ))}
    </span>
  );
}

export function CountryPage({ cc }: { cc: string }) {
  const wide = useWide();
  const [, setNamesReady] = useState(0);
  useEffect(() => void loadCountries().then(() => setNamesReady(1)), []);
  useGlobeSnapshots();
  const { room, loading, error } = useCountryRoom(cc);
  const snap = useSnapshot(room);
  const gaps = useLive((s) => s.stats.gaps);
  const globeHealth = useGlobe((s) => (s.version, s.countries.get(cc)?.h));
  const health = globeHealth ?? snap?.health;
  const probeCount = useGlobe((s) => {
    void s.version;
    let n = 0;
    for (const [, , pcc] of s.probePos.values()) if (pcc === cc) n += 1;
    return n;
  });
  const n = (v: number | undefined, digits = 0) =>
    v === undefined ? '—' : digits ? v.toFixed(digits) : formatInt(v);

  return (
    <main className="relative min-h-dvh">
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(90%_60%_at_20%_0%,#0c1d2f_0%,#04060b_55%)]" />
      <div className="mx-auto w-full max-w-[1760px] px-4 pt-24 pb-12 sm:px-8 xl:px-12">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mb-5 text-xs tracking-[0.16em] text-mid uppercase transition hover:text-hi"
        >
          ← Back to the globe
        </button>

        <div className="grid animate-[rise_.7s_both] gap-5 lg:grid-cols-12">
          <section className="glass relative overflow-hidden rounded-2xl lg:col-span-7">
            <div className="absolute top-5 left-5 z-10">
              <div className="text-[0.68rem] tracking-[0.22em] text-low uppercase">
                Country · {cc}
              </div>
              <h1 className="mt-1 flex items-center gap-3 text-3xl font-semibold tracking-tight text-hi sm:text-4xl 2xl:text-5xl">
                <span>{flag(cc)}</span>
                {countryName(cc)}
              </h1>
              <div className="mt-3">
                <WatchButton cc={cc} />
              </div>
            </div>
            <div className="aspect-[640/380] w-full pt-16">
              <CountryMap cc={cc} health={health} />
            </div>
            <div className="absolute right-5 bottom-4 left-5 flex flex-wrap items-center justify-between gap-2 text-[0.66rem] text-mid">
              <span>{formatInt(probeCount)} RIPE Atlas probes located here</span>
              <span className="flex flex-wrap gap-2.5">
                {BUCKET_LABELS.map((label, i) => (
                  <span key={label} className="flex items-center gap-1">
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: BUCKET_COLORS[i] }}
                    />
                    {label}
                  </span>
                ))}
              </span>
            </div>
          </section>

          <section className="glass flex flex-col gap-5 rounded-2xl p-5 lg:col-span-5">
            <div className="flex items-center gap-5">
              <HealthGauge value={health} />
              <div className="min-w-0 flex-1">
                <div className="text-[0.68rem] tracking-[0.22em] text-low uppercase">
                  Network health
                </div>
                <p className="mt-2 text-sm leading-relaxed text-mid">
                  How {countryName(cc)}&apos;s networks look in the latest minute: what share of
                  route changes were <span className="text-caution">withdrawals</span>, and how many
                  probe pings got <span className="text-hi">no reply</span>.
                </p>
              </div>
            </div>
            <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-3">
              <Kpi
                tall={wide}
                delay={0.33}
                label="Route changes"
                value={n(snap?.perSecond)}
                unit="/ s"
                spark={snap?.spark.perSecond ?? []}
                color={colors.announce}
                hint="Announcements plus withdrawals, last 2 minutes"
              />
              <Kpi
                tall={wide}
                delay={0.41}
                label="Withdrawn"
                value={n(snap?.withdrawnLastMinute)}
                unit="last min"
                spark={snap?.spark.withdrawn ?? []}
                color={colors.withdraw}
                hint="Routes withdrawn per minute, last hour"
              />
              <Kpi
                tall={wide}
                delay={0.49}
                label="Median latency"
                value={n(snap?.p50, 1)}
                unit="ms"
                spark={snap?.spark.p50 ?? []}
                color="#9b8cff"
                hint="To the root DNS servers, per minute, last hour"
              />
              <Kpi
                tall={wide}
                delay={0.57}
                label="Probes reporting / min"
                value={n(snap?.probes)}
                spark={snap?.spark.probes ?? []}
                color={colors.signal}
                hint="Distinct probes that reported in a minute, last hour"
              />
            </div>
          </section>
        </div>

        <section className="glass mt-5 animate-[rise_.7s_.1s_both] rounded-2xl p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[0.68rem] font-medium tracking-[0.22em] text-mid uppercase">
              Health · last 24 hours, one bar per minute
            </h2>
            <span className="flex items-center gap-2 text-[0.66rem] text-low">
              <span
                className="h-1.5 w-16 rounded-full"
                style={{
                  background: `linear-gradient(90deg, ${healthColor(10)}, ${healthColor(45)}, ${healthColor(100)})`,
                }}
              />
              disrupted → healthy
            </span>
          </div>
          <HealthStrip room={room} />
          <div className="mt-1.5 flex justify-between font-mono text-[0.62rem] text-low">
            <span>24 h ago</span>
            <span>12 h ago</span>
            <span>now</span>
          </div>
        </section>

        <div className="mt-5 animate-[rise_.7s_.15s_both]">
          <CountryIncidents cc={cc} />
        </div>

        {error && (
          <p className="mt-6 text-sm text-caution">Could not load history: {String(error)}</p>
        )}

        <div className="mt-5 grid animate-[rise_.7s_.2s_both] gap-5">
          <Panel
            title="Route changes per second · last 15 minutes"
            aside={
              <SeriesKey
                items={[
                  ['announced', colors.announce],
                  ['withdrawn', colors.withdraw],
                ]}
              />
            }
          >
            {loading && <div className="py-2 text-xs text-low">Loading history from MongoDB…</div>}
            <TimeChart
              room={room}
              height={wide ? 300 : 220}
              series={[
                { label: 'announced', stroke: colors.announce, fill: 'rgba(94,230,255,0.10)' },
                { label: 'withdrawn', stroke: colors.withdraw, fill: 'rgba(255,180,84,0.12)' },
              ]}
              build={(s) => columns(s.seconds, [(p) => p.ann, (p) => p.wd], 5_000)}
            />
          </Panel>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              title="Route changes per minute · 24 h"
              aside={
                <SeriesKey
                  items={[
                    ['announced', colors.announce],
                    ['withdrawn', colors.withdraw],
                  ]}
                />
              }
            >
              <TimeChart
                room={room}
                height={wide ? 260 : 200}
                series={[
                  { label: 'announced', stroke: colors.announce, fill: 'rgba(94,230,255,0.08)' },
                  { label: 'withdrawn', stroke: colors.withdraw, fill: 'rgba(255,180,84,0.10)' },
                ]}
                build={(s) => columns(s.minutes, [(p) => p.ann, (p) => p.wd], 5 * 60_000)}
              />
            </Panel>
            <Panel
              title="Latency to root DNS · per minute"
              aside={
                <SeriesKey
                  items={[
                    ['median', colors.signal],
                    ['95th pct', '#9b8cff'],
                  ]}
                />
              }
            >
              <TimeChart
                room={room}
                height={wide ? 260 : 200}
                unit=" ms"
                series={[
                  { label: 'median', stroke: colors.signal, width: 1.8 },
                  { label: 'p95', stroke: '#9b8cff', dash: [4, 4], fill: 'rgba(155,140,255,0.06)' },
                ]}
                build={(s) => columns(s.minutes, [(p) => p.p50, (p) => p.p95], 5 * 60_000)}
              />
            </Panel>
          </div>
        </div>

        <section className="mt-5 flex animate-[rise_.7s_.3s_both] flex-col gap-3 rounded-2xl border border-signal/10 bg-signal/[0.03] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[0.68rem] font-medium tracking-[0.22em] text-signal uppercase">
              Data integrity
            </div>
            <p className="mt-1 max-w-xl text-xs text-mid">
              History from MongoDB and live frames from Socket.IO join here. Every point is keyed by
              its time, frames already in the history snapshot are dropped, and a missing frame is
              fetched again.
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-x-5 gap-y-1 font-mono text-xs sm:grid-cols-5">
            {[
              ['snapshot', `#${snap?.snapshotSeq ?? '—'}`],
              ['live frame', `#${snap?.lastSeq ?? '—'}`],
              ['dropped', String(snap?.dropped ?? 0)],
              ['gaps', String(gaps)],
              ['points', `${snap?.seconds ?? 0}s · ${snap?.minutes ?? 0}m`],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[0.6rem] tracking-[0.14em] text-low uppercase">{k}</dt>
                <dd className="text-hi tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  );
}
