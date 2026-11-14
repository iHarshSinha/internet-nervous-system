import { SIGNAL_LABELS, type Incident, type Severity } from '@ins/shared';
import { memo, useEffect } from 'react';
import { countryName } from '../geo.ts';
import { useFlip } from '../hooks/flip.ts';
import { useTick } from '../hooks/tick.ts';
import { navigate } from '../router.ts';
import { useAlerts } from '../store/alerts.ts';
import { activeIncidents, dismissAlert, incidentTitle, useIncidents } from '../store/incidents.ts';
import { flag } from '../theme.ts';
import { Panel } from './ui.tsx';

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#ff4d5e',
  warning: '#ffb454',
  watch: '#9b8cff',
};

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function SeverityTag({ incident }: { incident: Incident }) {
  const color = SEVERITY_COLOR[incident.severity];
  return (
    <span
      className="rounded-full px-2 py-0.5 font-mono text-[0.72rem] font-semibold tracking-[0.12em] uppercase"
      style={{ color, background: `${color}1f`, boxShadow: `inset 0 0 0 1px ${color}55` }}
    >
      {incident.state === 'resolved' ? 'resolved' : incident.severity}
    </span>
  );
}

export function SimTag() {
  return (
    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[0.72rem] tracking-[0.12em] text-mid uppercase ring-1 ring-white/10">
      simulated
    </span>
  );
}

/**
 * Big enough to take over the screen: a whole country, a simulation being
 * demonstrated, or a network with a large footprint. A small network that
 * flaps (a couple of dozen address blocks) stays in the feed instead.
 */
export function isMajor(i: Incident): boolean {
  if (i.simulated || i.asn === null) return true;
  return i.signals.some(
    (s) =>
      (s.type === 'network_vanished' && Number(s.detail.known) >= 50) ||
      (s.type === 'withdrawal_storm' && Number(s.detail.prefixes) >= 100) ||
      (s.type === 'origin_change' && Number(s.detail.prefixes) >= 10),
  );
}

/** Live list of incidents, worst first. Everyone sees it. */
export const IncidentFeed = memo(function IncidentFeed() {
  const byId = useIncidents((s) => s.byId);
  const mine = useAlerts((s) => s.mine);
  useTick(5000); // keep the "x min ago" fresh
  const active = activeIncidents(byId);
  const recent = Object.values(byId)
    .filter((i) => i.state === 'resolved')
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, Math.max(0, 4 - active.length));
  const rows = [...active, ...recent].slice(0, 6);

  return (
    <Panel
      title="Incidents"
      collapsible
      id="incidents"
      aside={
        <span
          className={`font-mono text-[0.78rem] ${active.length ? 'text-critical' : 'text-low'}`}
        >
          {active.length ? `${active.length} active` : 'none active'}
        </span>
      }
    >
      {rows.length === 0 ? (
        <div className="flex items-center gap-3 text-[0.95rem] text-mid">
          <span className="size-1.5 rounded-full bg-signal" />
          Watching every network for outages and hijacks.
        </div>
      ) : (
        <IncidentRows rows={rows} mine={mine} />
      )}
    </Panel>
  );
});

/** Incident rows: severity, place, evidence, age; click for the incident page. */
function IncidentRows({ rows, mine }: { rows: Incident[]; mine: Record<string, number> }) {
  // New incidents slide in; reordered ones glide to their place.
  const list = useFlip<HTMLUListElement>([rows.map((i) => i.id).join()]);
  return (
    <ul ref={list} className="relative space-y-1">
      {rows.map((i) => {
        const color = SEVERITY_COLOR[i.severity];
        const live = i.state !== 'resolved';
        return (
          <li key={i.id} data-flip={i.id}>
            <button
              type="button"
              onClick={() => navigate(`/incident/${i.id}`)}
              className={`group relative w-full overflow-hidden rounded-md px-3 py-2 text-left transition hover:bg-white/[0.05] ${live ? 'bg-white/[0.03]' : 'opacity-60'}`}
            >
              {live && (
                <span
                  className="absolute inset-y-0 left-0 w-0.5"
                  style={{ background: color, boxShadow: `0 0 12px ${color}` }}
                />
              )}
              <div className="flex items-center gap-2">
                {live && i.state === 'open' && (
                  <span className="relative flex size-2">
                    <span
                      className="absolute inline-flex size-full animate-[halo_1.4s_ease-out_infinite] rounded-full"
                      style={{ background: color }}
                    />
                    <span
                      className="relative inline-flex size-2 rounded-full"
                      style={{ background: color }}
                    />
                  </span>
                )}
                <span className="text-base leading-none">{i.cc ? flag(i.cc) : '◌'}</span>
                <span className="min-w-0 flex-1 truncate text-[1.05rem] leading-tight font-semibold text-hi">
                  {incidentTitle(i, countryName)}
                </span>
                <span className="shrink-0 font-mono text-[0.72rem] text-low">
                  {ago(Date.now() - i.openedAt)}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.78rem] text-low">
                <SeverityTag incident={i} />
                <span className="text-mid">
                  {i.signals.map((s) => SIGNAL_LABELS[s.type]).join(' + ')}
                </span>
                {i.simulated && <SimTag />}
                {mine[i.id] && <span className="text-signal">★ on your watchlist</span>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Incidents in one country (its own and its networks'), for the country page. */
export function CountryIncidents({ cc }: { cc: string }) {
  const byId = useIncidents((s) => s.byId);
  const mine = useAlerts((s) => s.mine);
  useTick(5000);
  const rows = Object.values(byId)
    .filter((i) => i.cc === cc)
    .sort(
      (a, b) =>
        Number(b.state !== 'resolved') - Number(a.state !== 'resolved') || b.openedAt - a.openedAt,
    )
    .slice(0, 6);
  const active = rows.filter((i) => i.state !== 'resolved').length;
  return (
    <Panel
      title={`Incidents in ${countryName(cc)}`}
      aside={
        <span className={`font-mono text-[0.78rem] ${active ? 'text-critical' : 'text-low'}`}>
          {active ? `${active} active` : 'last 24 h'}
        </span>
      }
    >
      {rows.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg bg-signal/[0.05] px-3 py-2 text-[0.86rem] text-mid">
          <span className="size-1.5 rounded-full bg-signal shadow-[0_0_10px_var(--color-signal)]" />
          No incidents here in the last 24 hours
        </div>
      ) : (
        <IncidentRows rows={rows} mine={mine} />
      )}
    </Panel>
  );
}

/** The big alert that slides in when an incident opens while you watch. */
function AlertCard({ incident, personal }: { incident: Incident; personal: boolean }) {
  const color = SEVERITY_COLOR[incident.severity];
  const critical = incident.severity === 'critical' && incident.state === 'open';
  // Warnings leave by themselves; critical ones stay until they resolve or are closed.
  useEffect(() => {
    if (critical) return;
    const timer = setTimeout(() => dismissAlert(incident.id), 20_000);
    return () => clearTimeout(timer);
  }, [critical, incident.id]);
  useEffect(() => {
    if (incident.state !== 'resolved') return;
    const timer = setTimeout(() => dismissAlert(incident.id), 8000);
    return () => clearTimeout(timer);
  }, [incident.state, incident.id]);

  return (
    <div
      className="pointer-events-auto relative w-[min(330px,calc(100vw-2rem))] animate-[toast_.35s_ease-out_both] overflow-hidden rounded-lg border bg-[#1a1c20]/96 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] backdrop-blur"
      style={{ borderColor: `${color}55` }}
      role="alert"
    >
      {/* A thin strip in the severity colour, instead of a glow. */}
      <span className="absolute inset-y-0 left-0 w-0.5" style={{ background: color }} />
      <div className="flex items-start gap-2.5 py-2.5 pr-2 pl-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[0.78rem] font-semibold tracking-[0.06em] uppercase">
            <span style={{ color }}>
              {incident.state === 'resolved' ? 'Recovered' : critical ? 'Critical' : 'New incident'}
            </span>
            {incident.simulated && <span className="text-low">· simulated</span>}
            {personal && <span className="text-signal">· watchlist</span>}
          </div>
          <button
            type="button"
            onClick={() => {
              dismissAlert(incident.id);
              navigate(`/incident/${incident.id}`);
            }}
            className="mt-0.5 block w-full truncate text-left text-[0.98rem] font-semibold text-hi hover:underline"
            title={incidentTitle(incident, countryName)}
          >
            {incident.cc ? `${flag(incident.cc)} ` : ''}
            {incidentTitle(incident, countryName)}
          </button>
          <div className="truncate text-[0.84rem] text-mid">
            {incident.signals.map((s) => SIGNAL_LABELS[s.type]).join(' + ')}
            {incident.asn !== null ? ` · AS${incident.asn}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => dismissAlert(incident.id)}
          className="rounded px-1 text-[0.8rem] text-low transition hover:text-hi"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** Alerts for incidents that opened while this page was open (at most two at a time). */
export function IncidentAlerts() {
  const fresh = useIncidents((s) => s.fresh);
  const byId = useIncidents((s) => s.byId);
  const mine = useAlerts((s) => s.mine);
  // Big cards for what matters: critical incidents, simulations being demonstrated,
  // and anything on your watchlist. Everything else is in the incident feed.
  const shown = fresh
    .map((id) => byId[id])
    .filter(
      (i): i is Incident =>
        i !== undefined &&
        ((i.severity === 'critical' && isMajor(i)) || i.simulated || mine[i.id] !== undefined),
    )
    .slice(0, 3);
  if (shown.length === 0) return null;
  return (
    // Top right, under the header, on every page: out of the way of the globe and the reading column.
    <div className="pointer-events-none fixed top-[4.6rem] right-4 z-40 flex flex-col items-end gap-2 sm:right-6">
      {shown.map((i) => (
        <AlertCard key={i.id} incident={i} personal={mine[i.id] !== undefined} />
      ))}
    </div>
  );
}

/**
 * While a critical incident is open the whole screen says so: a slow red pulse
 * at the edges and a thin banner. Hard to miss on a wall screen or in a video.
 */
export function RedAlert() {
  const byId = useIncidents((s) => s.byId);
  const critical = activeIncidents(byId).find(
    (i) => i.severity === 'critical' && i.state === 'open' && isMajor(i),
  );
  if (!critical) return null;
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-30 animate-[alarm_2.4s_ease-in-out_infinite] shadow-[inset_0_0_160px_30px_rgba(255,77,94,0.45)]"
      />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-30 h-[3px] overflow-hidden bg-critical/30">
        <div className="h-full w-1/3 animate-[scan_1.8s_linear_infinite] bg-critical shadow-[0_0_16px_var(--color-critical)]" />
      </div>
    </>
  );
}
