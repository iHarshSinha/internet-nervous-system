import { REPLAY_SPEEDS, rooms, type DeltaValue } from '@ins/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type uPlot from 'uplot';
import { Legend, LiveChart } from '../charts/LiveChart.tsx';
import type { ChartSeries } from '../charts/TimeChart.tsx';
import { Panel } from '../components/ui.tsx';
import { subscribe, unsubscribe } from '../realtime/client.ts';
import { navigate } from '../router.ts';
import { authFetch, useAuth } from '../store/auth.ts';
import { useLive } from '../store/live.ts';
import { resetOps, useOps } from '../store/ops.ts';
import { formatInt } from '../theme.ts';

const C = {
  cyan: '#5ee6ff',
  amber: '#ffb454',
  violet: '#9b8cff',
  pink: '#d78cff',
  red: '#ff4d5e',
  grey: '#a6a9af',
};

const num = (v: DeltaValue | undefined): number | undefined =>
  typeof v === 'number' ? v : undefined;
const kb = (bytes: number | undefined) =>
  bytes === undefined
    ? '—'
    : bytes >= 1048576
      ? `${(bytes / 1048576).toFixed(1)} MB`
      : `${(bytes / 1024).toFixed(1)} KB`;

/** One headline number. */
function Tile({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint: string;
  tone?: string;
}) {
  return (
    <div className="glass rounded-lg px-4 py-3" title={hint}>
      <div className="text-[0.82rem] tracking-wide text-low uppercase">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className="font-mono text-[1.7rem] leading-none tabular-nums"
          style={{ color: tone ?? '#ededee' }}
        >
          {value}
        </span>
        {unit && <span className="text-[0.9rem] text-mid">{unit}</span>}
      </div>
    </div>
  );
}

/** The last five minutes from the `stats` room, as chart columns. */
function useLivePoints() {
  const version = useOps((s) => s.version);
  return useMemo(() => {
    const points = useOps.getState().points;
    const ts = [...points.keys()].sort((a, b) => a - b);
    const col = (f: (p: NonNullable<ReturnType<typeof points.get>>) => number) =>
      ts.map((t) => f(points.get(t)!));
    return {
      x: ts.map((t) => t / 1000),
      col,
    };
    // `version` changes on every new second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
}

interface Row {
  src: string;
  t: number;
  [k: string]: number | string;
}

/** Per-minute history (MongoDB ingest_stats), refreshed every minute. */
function useHistory(hours: number) {
  return useQuery({
    queryKey: ['ops-history', hours],
    queryFn: async () => {
      const res = await fetch(`/api/ops/history?from=${Date.now() - hours * 3600_000}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { rows: Row[] };
    },
    refetchInterval: 60_000,
  });
}

function historyColumns(rows: Row[], pick: [string, string][]): uPlot.AlignedData {
  const byT = new Map<number, Record<string, Row>>();
  for (const r of rows) {
    const at = byT.get(r.t) ?? {};
    at[r.src] = r;
    byT.set(r.t, at);
  }
  const ts = [...byT.keys()].sort((a, b) => a - b);
  const xs: number[] = [];
  const ys: (number | null)[][] = pick.map(() => []);
  ts.forEach((t, i) => {
    // Break the line across minutes with no record (the server was not running).
    const prev = ts[i - 1];
    if (prev !== undefined && t - prev > 3 * 60_000) {
      xs.push((prev + 60_000) / 1000);
      for (const c of ys) c.push(null);
    }
    xs.push(t / 1000);
    pick.forEach(([src, field], j) => {
      const v = byT.get(t)![src]?.[field];
      ys[j]!.push(
        typeof v === 'number' ? v : src === 'ris' || src === 'atlas' || src === 'replay' ? 0 : null,
      );
    });
  });
  return [xs, ...ys] as uPlot.AlignedData;
}

function ChartPanel({
  title,
  hint,
  series,
  data,
  unit,
  height = 170,
}: {
  title: string;
  hint: string;
  series: ChartSeries[];
  data: uPlot.AlignedData;
  unit?: string;
  height?: number;
}) {
  return (
    <Panel title={title} aside={<span className="text-[0.84rem] text-low">{hint}</span>}>
      <LiveChart data={data} series={series} unit={unit} height={height} />
      <Legend series={series} />
    </Panel>
  );
}

/** Admins only: drive the full-file replay (the load-test source). */
function ReplayControls() {
  const role = useAuth((s) => s.user?.role);
  const replay = useLive((s) => s.replay);
  const [speed, setSpeed] = useState<number>(10);
  const [amplify, setAmplify] = useState(1);
  const [lossy, setLossy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (role !== 'admin') return null;

  const send = async (body: object) => {
    setError(null);
    const res = await authFetch('/api/admin/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) setError(`The server said ${res.status}`);
  };
  const running =
    replay.state === 'playing' || replay.state === 'loading' || replay.state === 'paused';

  return (
    <Panel
      title="Replay (admin)"
      aside={<span className="font-mono text-[0.84rem] text-mid">{replay.state}</span>}
    >
      <p className="text-[0.95rem] text-mid">
        Plays the recorded Facebook outage (8.6 million events) through the same pipeline, as load.
        Amplify plays each event several times as if more routers had reported it; "like a live
        feed" sheds under pressure instead of waiting.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.92rem]">
        <label className="flex items-center gap-1.5 text-mid">
          Speed
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="glass rounded px-2 py-1 text-hi"
          >
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-mid">
          Amplify
          <select
            value={amplify}
            onChange={(e) => setAmplify(Number(e.target.value))}
            className="glass rounded px-2 py-1 text-hi"
          >
            {[1, 2, 5, 10, 20].map((a) => (
              <option key={a} value={a}>
                {a}×
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-mid">
          <input type="checkbox" checked={lossy} onChange={(e) => setLossy(e.target.checked)} />
          like a live feed
        </label>
        <span className="flex-1" />
        {!running ? (
          <button
            type="button"
            onClick={() =>
              void send({ action: 'start', scenario: 'facebook-2021', speed, amplify, lossy })
            }
            className="rounded-md bg-signal/15 px-3 py-1.5 text-signal ring-1 ring-signal/30"
          >
            Start
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void send({ action: replay.state === 'paused' ? 'resume' : 'pause' })}
              className="glass rounded-md px-3 py-1.5 text-hi"
            >
              {replay.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={() => void send({ action: 'stop' })}
              className="rounded-md bg-critical/15 px-3 py-1.5 text-critical ring-1 ring-critical/30"
            >
              Stop
            </button>
          </>
        )}
      </div>
      {error && <p className="mt-2 text-[0.9rem] text-critical">{error}</p>}
    </Panel>
  );
}

/**
 * Performance: how the pipeline is doing, live, and over the last hours.
 * Anyone can watch (judges included); admins can also drive the replay.
 */
export function OpsPage() {
  const now = useOps((s) => s.now);
  const live = useLivePoints();
  const [hours, setHours] = useState(6);
  const history = useHistory(hours);

  useEffect(() => {
    void subscribe([rooms.stats]);
    return () => {
      unsubscribe([rooms.stats]);
      resetOps();
    };
  }, []);

  const sources = Object.entries(now)
    .filter(([k]) => k.startsWith('in:'))
    .map(([k, f]) => ({ name: k.slice(3), eps: num(f.eps), lag: num(f.lag) }))
    .sort((a, b) => (b.eps ?? 0) - (a.eps ?? 0));
  const eps = sources.reduce((s, x) => s + (x.eps ?? 0), 0);
  const q = now.queue ?? {};
  const pressure = typeof q.pressure === 'string' ? q.pressure : 'normal';
  const rows = history.data?.rows ?? [];

  const counters: [string, number | undefined, string][] = [
    ['Duplicates dropped', num(now.pipe?.dup), 'The same event seen twice (reconnects, replays)'],
    [
      'Corrected into their second',
      num(now.pipe?.amended),
      'Arrived after their 1-second window closed and were added to it',
    ],
    [
      'Corrected into their minute',
      num(now.pipe?.amendedMin),
      'Arrived after their minute closed and were added to it (the stored minute is rewritten)',
    ],
    [
      'Too late to count',
      num(now.pipe?.late),
      'Arrived more than 10 minutes after their minute closed',
    ],
    ['Future-dated', num(now.pipe?.future), 'Stamped ahead of our clock, set aside'],
    ['Shed under load', num(q.shed), 'Dropped by priority because the queue was full'],
    ['Overflow', num(q.overflow), 'Refused at the queue hard limit'],
  ];

  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 pt-24 pb-16 sm:px-8">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="text-[0.92rem] text-mid hover:text-hi"
      >
        ← Globe
      </button>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="title text-[1.35rem]">Performance</h1>
          <p className="mt-1 max-w-2xl text-[0.98rem] text-mid">
            How the pipeline is doing, live from the server once a second, and minute by minute from
            MongoDB. Press ~ on any page for this browser's own numbers.
          </p>
        </div>
        {pressure !== 'normal' && (
          <span className="rounded-md bg-caution/15 px-3 py-1.5 font-mono text-[0.9rem] text-caution">
            {pressure === 'sampling' ? `sampling 1 in ${num(q.every) ?? '?'}` : pressure}
          </span>
        )}
      </div>

      <section className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Events in"
          value={formatInt(eps)}
          unit="/s"
          hint="Events arriving from all live sources, per second"
        />
        <Tile
          label="Processing"
          value={num(now.delay?.p99) ?? '—'}
          unit="ms p99"
          hint="From receiving an event to the pipeline and detectors having it, 99th percentile, last 10 s"
        />
        <Tile
          label="Second to screen"
          value={num(now.pub?.p50) === undefined ? '—' : (num(now.pub?.p50)! / 1000).toFixed(1)}
          unit="s median"
          hint="From the end of a second (event time) to its numbers leaving the server: waiting for slower collectors, plus 5 s for stragglers"
        />
        <Tile
          label="Queue"
          value={num(q.fill) === undefined ? '—' : `${Math.round(num(q.fill)! * 100)}%`}
          unit={`${formatInt(num(q.depth) ?? 0)} waiting`}
          hint="The bounded queue between the feeds and the pipeline. Above 70% the raw feed is sampled; above 95% announcements are shed"
          tone={pressure === 'normal' ? undefined : C.amber}
        />
        <Tile
          label="Browsers"
          value={num(now.sock?.live) ?? '—'}
          unit={num(now.sock?.slow) ? `${num(now.sock?.slow)} slow` : 'connected'}
          hint="Sockets on /live; slow ones get 2-second summaries"
        />
        <Tile
          label="Sent"
          value={kb(num(now.out?.bps))}
          unit="/s"
          hint="Bytes written to all browsers per second (MessagePack)"
        />
        <Tile
          label="Event loop"
          value={`${num(now.loop?.main) ?? '—'} / ${num(now.loop?.ingest) ?? '—'}`}
          unit="ms p99"
          hint="How late timers run, main thread / ingest thread, 99th percentile, last 10 s"
        />
        <Tile
          label="MongoDB write"
          value={num(now.mongo?.writeMs) ?? '—'}
          unit="ms"
          hint="Last bulk write of closed minutes (idempotent $set)"
        />
      </section>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Events per second"
          hint="last 5 min"
          series={[
            { label: 'in', stroke: C.cyan, fill: 'rgba(94,230,255,0.08)' },
            { label: 'processed', stroke: C.violet, dash: [4, 3] },
          ]}
          data={[live.x, live.col((p) => p.eps), live.col((p) => p.rps)] as uPlot.AlignedData}
        />
        <ChartPanel
          title="Delays"
          hint="ms, last 5 min"
          unit=""
          series={[
            { label: 'processing p99', stroke: C.cyan },
            { label: 'main loop p99', stroke: C.amber },
            { label: 'ingest loop p99', stroke: C.pink },
          ]}
          data={
            [
              live.x,
              live.col((p) => p.delayP99),
              live.col((p) => p.loopMain),
              live.col((p) => p.loopIngest),
            ] as uPlot.AlignedData
          }
        />
        <ChartPanel
          title="Sent to browsers"
          hint="bytes/s, last 5 min"
          series={[{ label: 'bytes per second', stroke: C.violet, fill: 'rgba(155,140,255,0.10)' }]}
          data={[live.x, live.col((p) => p.bps)] as uPlot.AlignedData}
        />
        <ChartPanel
          title="Queue depth"
          hint="events waiting, last 5 min"
          series={[{ label: 'waiting', stroke: C.amber, fill: 'rgba(255,180,84,0.10)' }]}
          data={[live.x, live.col((p) => p.queueDepth)] as uPlot.AlignedData}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Panel
          title="Sources"
          aside={<span className="text-[0.84rem] text-low">events/s · lag</span>}
        >
          {sources.length === 0 ? (
            <p className="text-[0.95rem] text-mid">Waiting for the first numbers…</p>
          ) : (
            <dl className="divide-y divide-line/70">
              {sources.map((s) => (
                <div key={s.name} className="flex justify-between gap-3 py-1.5 text-[0.95rem]">
                  <dt className="text-mid">{s.name}</dt>
                  <dd className="font-mono text-hi tabular-nums">
                    {formatInt(s.eps ?? 0)}/s{' '}
                    <span className="text-low">· {s.lag === undefined ? '—' : `${s.lag}s`}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>
        <Panel
          title="Data quality"
          aside={<span className="text-[0.84rem] text-low">since start</span>}
        >
          <dl className="divide-y divide-line/70">
            {counters.map(([k, v, hint]) => (
              <div
                key={k}
                className="flex justify-between gap-3 py-1.5 text-[0.95rem]"
                title={hint}
              >
                <dt className="text-mid">{k}</dt>
                <dd className="font-mono text-hi tabular-nums">
                  {v === undefined ? '—' : formatInt(v)}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <h2 className="title text-[1.05rem]">Minute by minute</h2>
        <span className="text-[0.92rem] text-mid">from MongoDB ingest_stats</span>
        <div className="glass ml-auto flex rounded-md p-0.5">
          {[1, 6, 24].map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHours(h)}
              className={`rounded px-2.5 py-1 text-[0.9rem] ${hours === h ? 'bg-white/[0.09] text-hi' : 'text-mid'}`}
            >
              {h} h
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-[0.95rem] text-mid">
          {history.isLoading
            ? 'Loading…'
            : 'No minutes recorded yet (the first full minute appears after two).'}
        </p>
      ) : (
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <ChartPanel
            title="Events per minute"
            hint="by source"
            series={[
              { label: 'RIS (routing)', stroke: C.cyan },
              { label: 'Atlas (latency)', stroke: C.violet },
              { label: 'replay', stroke: C.grey, dash: [4, 3] },
            ]}
            data={historyColumns(rows, [
              ['ris', 'events'],
              ['atlas', 'events'],
              ['replay', 'events'],
            ])}
          />
          <ChartPanel
            title="Late and repeated events"
            hint="per minute"
            series={[
              { label: 'corrected into their second', stroke: C.cyan },
              { label: 'duplicates', stroke: C.amber },
              { label: 'late for their minute', stroke: C.red },
            ]}
            data={historyColumns(rows, [
              ['pipeline', 'amendedSecond'],
              ['pipeline', 'duplicates'],
              ['pipeline', 'lateMinute'],
            ])}
          />
          <ChartPanel
            title="Delays"
            hint="ms, p99 at each minute"
            series={[
              { label: 'processing', stroke: C.cyan },
              { label: 'main loop', stroke: C.amber },
              { label: 'ingest loop', stroke: C.pink },
            ]}
            data={historyColumns(rows, [
              ['pipeline', 'delayP99'],
              ['delivery', 'mainLoopP99'],
              ['pipeline', 'ingestLoopP99'],
            ])}
          />
          <ChartPanel
            title="Delivery"
            hint="bytes per minute"
            series={[{ label: 'bytes sent', stroke: C.violet, fill: 'rgba(155,140,255,0.10)' }]}
            data={historyColumns(rows, [['delivery', 'bytes']])}
          />
        </div>
      )}

      <div className="mt-6">
        <ReplayControls />
      </div>
    </main>
  );
}
