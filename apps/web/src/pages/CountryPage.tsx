import { rooms, type HistoryResponse } from '@ins/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { columns, TimeChart } from '../charts/TimeChart.tsx';
import { Panel, Stat } from '../components/ui.tsx';
import { countryName, loadCountries } from '../geo.ts';
import { subscribe, unsubscribe } from '../realtime/client.ts';
import { navigate } from '../router.ts';
import { useGlobe } from '../store/globe.ts';
import { useLive } from '../store/live.ts';
import { closeSeries, getSeries, loadHistory, openSeries, useSeries } from '../store/series.ts';
import { colors, flag, formatInt, healthColor } from '../theme.ts';

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
  const secs = [...s.seconds.entries()].sort((a, b) => b[0] - a[0]);
  const mins = [...s.minutes.entries()].sort((a, b) => b[0] - a[0]);
  const lastSecond = secs[0]?.[1];
  const lastRouting = mins.find(([, p]) => p.ann !== undefined)?.[1];
  const lastLatency = mins.find(([, p]) => typeof p.p50 === 'number')?.[1];
  return {
    health: s.health,
    perSecond: lastSecond ? (lastSecond.ann ?? 0) + (lastSecond.wd ?? 0) : undefined,
    withdrawnLastMinute: lastRouting?.wd,
    p50: lastLatency?.p50 ?? undefined,
    probes: lastLatency?.up,
    seconds: s.seconds.size,
    minutes: s.minutes.size,
    snapshotSeq: s.snapshotSeq,
    lastSeq: s.lastSeq,
    dropped: s.droppedBySnapshot,
  };
}

export function CountryPage({ cc }: { cc: string }) {
  const [, setNamesReady] = useState(0);
  useEffect(() => void loadCountries().then(() => setNamesReady(1)), []);
  const { room, loading, error } = useCountryRoom(cc);
  const snap = useSnapshot(room);
  const gaps = useLive((s) => s.stats.gaps);
  const globeHealth = useGlobe((s) => (s.version, s.countries.get(cc)?.h));
  const health = globeHealth ?? snap?.health;
  const tone = healthColor(health);

  return (
    <main className="relative min-h-dvh">
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(90%_60%_at_20%_0%,#0b1a2a_0%,#04060b_55%)]" />
      <div className="mx-auto max-w-6xl px-4 pb-12 pt-24 sm:px-7">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mb-6 text-xs tracking-[0.16em] text-mid uppercase transition hover:text-hi"
        >
          ← Back to the globe
        </button>

        <div className="flex animate-[rise_.7s_both] flex-wrap items-end justify-between gap-6">
          <div>
            <div className="text-xs tracking-[0.2em] text-low uppercase">Country · {cc}</div>
            <h1 className="mt-1 flex items-center gap-3 text-4xl font-semibold tracking-tight text-hi sm:text-5xl">
              <span>{flag(cc)}</span>
              {countryName(cc)}
            </h1>
            <p className="mt-2 max-w-xl text-sm text-mid">
              Routing changes for networks <em>registered</em> in {countryName(cc)}, and latency
              measured by RIPE Atlas probes physically located there.
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs tracking-[0.2em] text-low uppercase">Health</div>
            <div
              className="font-mono text-6xl font-medium tabular-nums"
              style={{ color: tone, textShadow: `0 0 32px ${healthColor(health, 0.35)}` }}
            >
              {health ?? '—'}
            </div>
          </div>
        </div>

        <div className="glass mt-8 grid animate-[rise_.7s_.1s_both] grid-cols-2 gap-x-6 gap-y-4 rounded-2xl p-5 sm:grid-cols-4">
          <Stat
            label="Route changes"
            value={snap?.perSecond === undefined ? '—' : formatInt(snap.perSecond)}
            unit="/ s"
          />
          <Stat
            label="Withdrawn, last minute"
            value={
              snap?.withdrawnLastMinute === undefined ? '—' : formatInt(snap.withdrawnLastMinute)
            }
          />
          <Stat
            label="Median latency"
            value={snap?.p50 === undefined ? '—' : snap.p50.toFixed(1)}
            unit="ms"
            hint="To the root DNS servers, latest minute"
          />
          <Stat
            label="Probes reporting"
            value={snap?.probes === undefined ? '—' : formatInt(snap.probes)}
          />
        </div>

        {error && (
          <p className="mt-6 text-sm text-caution">Could not load history: {String(error)}</p>
        )}

        <div className="mt-6 grid animate-[rise_.7s_.2s_both] gap-6">
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
            {loading && <Loading />}
            <TimeChart
              room={room}
              height={220}
              series={[
                { label: 'announced', stroke: colors.announce, fill: 'rgba(94,230,255,0.10)' },
                { label: 'withdrawn', stroke: colors.withdraw, fill: 'rgba(255,180,84,0.12)' },
              ]}
              build={(s) => columns(s.seconds, [(p) => p.ann, (p) => p.wd], 5_000)}
            />
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel
              title="Route changes per minute · last 24 hours"
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
                series={[
                  { label: 'announced', stroke: colors.announce, fill: 'rgba(94,230,255,0.08)' },
                  { label: 'withdrawn', stroke: colors.withdraw, fill: 'rgba(255,180,84,0.10)' },
                ]}
                build={(s) => columns(s.minutes, [(p) => p.ann, (p) => p.wd], 5 * 60_000)}
              />
            </Panel>
            <Panel
              title="Latency to the root DNS servers · per minute"
              aside={
                <SeriesKey
                  items={[
                    ['median', colors.signal],
                    ['95th percentile', '#9b8cff'],
                  ]}
                />
              }
            >
              <TimeChart
                room={room}
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

        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[0.68rem] text-low">
          <span>
            history snapshot <span className="text-mid">#{snap?.snapshotSeq ?? '—'}</span>
          </span>
          <span>
            last live frame <span className="text-mid">#{snap?.lastSeq ?? '—'}</span>
          </span>
          <span>
            frames already in history, dropped{' '}
            <span className="text-mid">{snap?.dropped ?? 0}</span>
          </span>
          <span>
            gaps <span className="text-mid">{gaps}</span>
          </span>
          <span>
            points{' '}
            <span className="text-mid">
              {snap?.seconds ?? 0} s · {snap?.minutes ?? 0} min
            </span>
          </span>
        </div>
      </div>
    </main>
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

function Loading() {
  return <div className="py-2 text-xs text-low">Loading history from MongoDB…</div>;
}
