import {
  rooms,
  SIGNAL_LABELS,
  type HistoryResponse,
  type Incident,
  type IncidentSignal,
} from '@ins/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { columns, TimeChart } from '../charts/TimeChart.tsx';
import { ago, SEVERITY_COLOR, SeverityTag, SimTag } from '../components/Incidents.tsx';
import { Panel } from '../components/ui.tsx';
import { countryName } from '../geo.ts';
import { useTick } from '../hooks/tick.ts';
import { subscribe, unsubscribe } from '../realtime/client.ts';
import { navigate } from '../router.ts';
import { useAlerts } from '../store/alerts.ts';
import { incidentTitle, merge, useIncidents } from '../store/incidents.ts';
import { closeSeries, loadHistory, openSeries } from '../store/series.ts';
import { colors, flag, formatInt } from '../theme.ts';

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC';

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${s % 60}s` : `${s}s`;
}

/** The incident: live from the incidents room when we have it, otherwise fetched once. */
function useIncident(id: string): { incident: Incident | undefined; missing: boolean } {
  const incident = useIncidents((s) => s.byId[id]);
  const fetched = useQuery({
    queryKey: ['incident', id],
    queryFn: async () => {
      const res = await fetch(`/api/incidents/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Incident;
    },
    enabled: !incident,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (fetched.data) merge([fetched.data], false);
  }, [fetched.data]);
  return { incident, missing: fetched.data === null };
}

/** The network's (or country's) per-minute history, joined live: room first, then history. */
function useScopeHistory(incident: Incident | undefined) {
  const asn = incident?.asn ?? null;
  const scope = asn !== null ? 'asn' : 'country';
  const key = asn !== null ? String(asn) : (incident?.cc ?? '');
  const room = incident ? (scope === 'asn' ? rooms.asn(Number(key)) : rooms.country(key)) : null;
  const from = incident ? incident.openedAt - 30 * 60_000 : 0;
  const [joined, setJoined] = useState<string | null>(null);

  useEffect(() => {
    if (!room) return;
    openSeries(room);
    let alive = true;
    void subscribe([room]).then(() => alive && setJoined(room));
    return () => {
      alive = false;
      unsubscribe([room]);
      closeSeries(room);
    };
  }, [room]);

  const history = useQuery({
    queryKey: ['incident-history', room, joined],
    queryFn: async () => {
      const res = await fetch(`/api/history?scope=${scope}&key=${key}&from=${from}`);
      if (!res.ok) throw new Error(`history: HTTP ${res.status}`);
      return (await res.json()) as HistoryResponse;
    },
    enabled: joined !== null && joined === room,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (history.data) loadHistory(history.data);
  }, [history.data]);
  return { room, loading: history.isPending };
}

/** The headline number for a network that is going dark: address blocks still reachable. */
function Reachability({ incident }: { incident: Incident }) {
  const vanished = incident.signals.find((s) => s.type === 'network_vanished');
  if (!vanished) return null;
  const known = Number(vanished.detail.known);
  const reachable = Number(vanished.detail.reachable);
  const gone = Number(vanished.detail.gone);
  const share = known > 0 ? reachable / known : 1;
  return (
    <Panel title="Still reachable">
      <div className="flex items-end gap-3">
        <span
          className="font-mono text-6xl leading-none font-semibold tabular-nums"
          style={{ color: share < 0.5 ? colors.critical : colors.caution }}
        >
          {formatInt(reachable)}
        </span>
        <span className="mb-1 text-sm text-mid">of {formatInt(known)} address blocks</span>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-critical/25">
        <div
          className="h-full rounded-full bg-signal transition-[width] duration-1000"
          style={{ width: `${share * 100}%` }}
        />
      </div>
      <p className="mt-3 text-xs text-low">
        {formatInt(gone)} withdrawn by routers all over the world. When this reaches zero, nobody on
        the internet can find a route to the network.
      </p>
    </Panel>
  );
}

const DETAIL_LABELS: Record<string, string> = {
  withdrawals: 'withdrawals in a minute',
  prefixes: 'address blocks',
  peers: 'routers reporting',
  times: '× normal rate',
  z: 'robust z-score',
  gone: 'blocks withdrawn',
  known: 'blocks known',
  share: '% gone',
  reachable: 'still reachable',
  hijacker: 'announced by AS',
  collectors: 'collectors',
  example: 'example block',
  probes: 'probes measuring',
  degraded: 'probes degraded',
  disconnected: 'probes disconnected',
};

function Evidence({ signal, now }: { signal: IncidentSignal; now: number }) {
  const live = signal.lastAt >= now - 5000;
  return (
    <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
      <div className="flex items-center gap-2">
        <span
          className={`size-2 rounded-full ${live ? 'animate-[blink_1s_infinite] bg-critical' : 'bg-low'}`}
        />
        <span className="text-sm font-medium text-hi">{SIGNAL_LABELS[signal.type]}</span>
        <span className="ml-auto font-mono text-[0.66rem] text-low">
          weight {signal.weight.toFixed(2)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {Object.entries(signal.detail).map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 text-[0.7rem]">
            <dt className="truncate text-low">{DETAIL_LABELS[k] ?? k}</dt>
            <dd className="font-mono text-mid tabular-nums">
              {typeof v === 'number' ? formatInt(v) : v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 text-[0.64rem] text-low">
        first {time(signal.firstAt)} · {live ? 'still firing' : `last ${ago(now - signal.lastAt)}`}
      </div>
    </div>
  );
}

export function IncidentPage({ id }: { id: string }) {
  const { incident, missing } = useIncident(id);
  const personal = useAlerts((s) => s.mine[id] !== undefined);
  const { room, loading } = useScopeHistory(incident);
  useTick(1000);
  const now = Date.now();

  if (!incident) {
    return (
      <main className="mx-auto max-w-3xl px-6 pt-32 text-center">
        <p className="text-mid">{missing ? 'No incident with that ID.' : 'Loading incident…'}</p>
        <button type="button" onClick={() => navigate('/')} className="mt-6 text-sm text-signal">
          ← Back to the globe
        </button>
      </main>
    );
  }

  const color = SEVERITY_COLOR[incident.severity];
  const open = incident.state !== 'resolved';
  const end = incident.resolvedAt ?? now;

  return (
    <main className="relative mx-auto w-full max-w-[1500px] px-4 pt-24 pb-16 sm:px-8">
      {open && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-40"
          style={{ background: `radial-gradient(60% 100% at 50% 0%, ${color}33, transparent)` }}
        />
      )}
      <button
        type="button"
        onClick={() => navigate('/')}
        className="relative text-xs text-low transition hover:text-hi"
      >
        ← Globe
      </button>

      <header className="relative mt-3 animate-[rise_.6s_both]">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityTag incident={incident} />
          <span className="font-mono text-[0.66rem] tracking-[0.16em] text-mid uppercase">
            {incident.state === 'open'
              ? 'in progress'
              : incident.state === 'resolving'
                ? 'recovering'
                : 'resolved'}
          </span>
          {incident.simulated && <SimTag />}
          {personal && <span className="text-xs text-signal">★ on your watchlist</span>}
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-hi sm:text-5xl">
          {incident.cc ? `${flag(incident.cc)} ` : ''}
          {incidentTitle(incident, countryName)}
          {incident.asn !== null && (
            <span className="ml-3 font-mono text-xl font-normal text-mid sm:text-2xl">
              AS{incident.asn}
            </span>
          )}
        </h1>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-mid">
          <span>Opened {time(incident.openedAt)}</span>
          <span>
            {open ? 'Running for' : 'Lasted'}{' '}
            <span className="font-mono text-hi tabular-nums">
              {duration(end - incident.openedAt)}
            </span>
          </span>
          {incident.cc && (
            <button
              type="button"
              onClick={() => navigate(`/c/${incident.cc}`)}
              className="text-signal hover:underline"
            >
              {countryName(incident.cc)} live →
            </button>
          )}
        </div>
      </header>

      <div className="relative mt-8 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="What happened">
            <p className="text-[0.95rem] leading-relaxed text-hi">{incident.summary}</p>
            <div className="mt-5 flex items-center gap-4">
              <span className="text-[0.66rem] tracking-[0.18em] text-low uppercase">Score</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{
                    width: `${incident.score * 100}%`,
                    background: color,
                    boxShadow: `0 0 18px ${color}`,
                  }}
                />
              </div>
              <span className="font-mono text-lg tabular-nums" style={{ color }}>
                {Math.round(incident.score * 100)}
              </span>
              <span className="text-xs text-low">peak {Math.round(incident.peakScore * 100)}</span>
            </div>
            <p className="mt-3 text-xs text-low">
              The score adds up independent kinds of evidence from the last 10 minutes. One signal
              alone rarely makes an incident; several agreeing do. Summary written from the numbers
              by a template, no AI.
            </p>
          </Panel>

          {room && (
            <Panel
              title={
                incident.asn !== null
                  ? `AS${incident.asn} · route changes per minute`
                  : `${countryName(incident.cc ?? '')} · route changes per minute`
              }
            >
              {loading && <div className="py-2 text-xs text-low">Loading history…</div>}
              <TimeChart
                room={room}
                height={260}
                series={[
                  { label: 'announced', stroke: colors.announce, fill: 'rgba(94,230,255,0.10)' },
                  { label: 'withdrawn', stroke: colors.critical, fill: 'rgba(255,77,94,0.18)' },
                ]}
                build={(s) => columns(s.minutes, [(p) => p.ann, (p) => p.wd], 90_000)}
              />
              <p className="mt-2 text-[0.68rem] text-low">
                From 30 minutes before the incident; MongoDB history merged with the live room.
              </p>
            </Panel>
          )}

          <Panel title="Evidence">
            <div className="grid gap-3 sm:grid-cols-2">
              {incident.signals.map((s) => (
                <Evidence key={s.type} signal={s} now={now} />
              ))}
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Reachability incident={incident} />
          <Panel title="Timeline">
            <ol className="relative space-y-4 border-l border-line pl-5">
              {incident.timeline.map((t, i) => (
                <li key={`${t.at}-${i}`} className="relative animate-[rise_.4s_both]">
                  <span
                    className="absolute top-1.5 -left-[25px] size-2 rounded-full ring-4 ring-void"
                    style={{ background: i === 0 ? color : colors.mid }}
                  />
                  <div className="font-mono text-[0.66rem] text-low">{time(t.at)}</div>
                  <div className="mt-0.5 text-[0.8rem] leading-snug text-hi">{t.text}</div>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </main>
  );
}
