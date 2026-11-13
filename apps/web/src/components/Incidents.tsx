import { SIGNAL_LABELS, type Incident, type Severity } from '@ins/shared';
import { memo, useEffect } from 'react';
import { countryName } from '../geo.ts';
import { useTick } from '../hooks/tick.ts';
import { navigate, useRoute } from '../router.ts';
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
      className="rounded-full px-2 py-0.5 font-mono text-[0.6rem] font-semibold tracking-[0.12em] uppercase"
      style={{ color, background: `${color}1f`, boxShadow: `inset 0 0 0 1px ${color}55` }}
    >
      {incident.state === 'resolved' ? 'resolved' : incident.severity}
    </span>
  );
}

export function SimTag() {
  return (
    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[0.58rem] tracking-[0.12em] text-mid uppercase ring-1 ring-white/10">
      simulated
    </span>
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
      aside={
        <span
          className={`font-mono text-[0.68rem] ${active.length ? 'text-critical' : 'text-low'}`}
        >
          {active.length ? `${active.length} active` : 'none active'}
        </span>
      }
    >
      {rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl bg-signal/[0.05] px-3 py-3 text-sm text-mid">
          <span className="size-2 rounded-full bg-signal shadow-[0_0_10px_var(--color-signal)]" />
          Watching every network for outages and hijacks.
        </div>
      ) : (
        <ul className="space-y-1">
          {rows.map((i) => {
            const color = SEVERITY_COLOR[i.severity];
            const live = i.state !== 'resolved';
            return (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/incident/${i.id}`)}
                  className={`group relative w-full overflow-hidden rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.05] ${live ? 'bg-white/[0.03]' : 'opacity-60'}`}
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
                    <span className="text-sm leading-none">{i.cc ? flag(i.cc) : '◌'}</span>
                    <span className="min-w-0 flex-1 truncate text-[0.82rem] font-medium text-hi">
                      {incidentTitle(i, countryName)}
                    </span>
                    <SeverityTag incident={i} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-0.5 text-[0.66rem] text-low">
                    <span>{i.signals.map((s) => SIGNAL_LABELS[s.type]).join(' + ')}</span>
                    <span>·</span>
                    <span>{ago(Date.now() - i.openedAt)}</span>
                    {i.simulated && <SimTag />}
                    {mine[i.id] && <span className="text-signal">★ on your watchlist</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
});

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
      className="pointer-events-auto relative w-[min(560px,92vw)] animate-[pop_.5s_both] overflow-hidden rounded-2xl border bg-[#0d0709]/95 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.9)] backdrop-blur"
      style={{ borderColor: `${color}80`, boxShadow: `0 0 60px -10px ${color}66` }}
      role="alert"
    >
      {critical && (
        <span
          className="absolute inset-x-0 top-0 h-0.5 animate-[sweep_1.6s_linear_infinite]"
          style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }}
        />
      )}
      <div className="flex items-start gap-3 p-4">
        <span
          className={`mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl text-xl ${critical ? 'animate-[blink_1.2s_infinite]' : ''}`}
          style={{ background: `${color}22`, color }}
        >
          ⚠
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="font-mono text-[0.62rem] font-semibold tracking-[0.2em] uppercase"
              style={{ color }}
            >
              {incident.state === 'resolved'
                ? 'Recovered'
                : critical
                  ? 'Critical incident'
                  : 'Incident detected'}
            </span>
            {incident.simulated && <SimTag />}
            {personal && <span className="text-[0.66rem] text-signal">★ on your watchlist</span>}
          </div>
          <div className="mt-1 text-lg leading-snug font-semibold text-hi">
            {incident.cc ? `${flag(incident.cc)} ` : ''}
            {incidentTitle(incident, countryName)}
            {incident.asn !== null && (
              <span className="ml-2 font-mono text-sm font-normal text-mid">AS{incident.asn}</span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[0.8rem] text-mid">{incident.summary}</p>
          <div className="mt-3 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full transition-[width] duration-700"
                style={{ width: `${Math.round(incident.score * 100)}%`, background: color }}
              />
            </div>
            <span className="font-mono text-xs tabular-nums" style={{ color }}>
              {Math.round(incident.score * 100)}
            </span>
            <button
              type="button"
              onClick={() => {
                dismissAlert(incident.id);
                navigate(`/incident/${incident.id}`);
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-hi ring-1 ring-white/15 transition hover:bg-white/10"
            >
              Investigate →
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => dismissAlert(incident.id)}
          className="rounded-md px-1.5 text-low transition hover:text-hi"
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
  const onGlobe = useRoute((s) => s.route.page === 'globe');
  // Big cards for what matters: critical incidents, simulations being demonstrated,
  // and anything on your watchlist. Everything else is in the incident feed.
  const shown = fresh
    .map((id) => byId[id])
    .filter(
      (i): i is Incident =>
        i !== undefined && (i.severity === 'critical' || i.simulated || mine[i.id] !== undefined),
    )
    .slice(0, 2);
  if (shown.length === 0) return null;
  return (
    <div
      className={`pointer-events-none fixed z-40 flex flex-col gap-2 px-3 ${
        onGlobe
          ? 'inset-x-0 top-20 items-center'
          : 'right-0 bottom-4 items-end max-sm:inset-x-0 max-sm:items-center'
      }`}
    >
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
    (i) => i.severity === 'critical' && i.state === 'open',
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
