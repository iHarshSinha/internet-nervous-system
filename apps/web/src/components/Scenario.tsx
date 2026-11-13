import { SCENARIO_IDS, SCENARIOS, type ScenarioCommand, type ScenarioId } from '@ins/shared';
import { useState } from 'react';
import { useTick } from '../hooks/tick.ts';
import { authFetch, useAuth } from '../store/auth.ts';
import { countryName } from '../geo.ts';
import { useLive } from '../store/live.ts';
import { useUi } from '../store/ui.ts';
import { flag } from '../theme.ts';
import { Panel } from './ui.tsx';

const PHASE_TEXT: Record<string, string> = {
  priming: 'Setting the scene',
  outage: 'Routes being withdrawn',
  gone: 'Network unreachable',
  recovery: 'Coming back (simulated)',
  hijack: 'Routes announced by a stranger',
  latency: 'Probes slowing down',
  dropout: 'Probes disconnecting',
  blackout: 'Networks going dark',
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function useProgress() {
  const scenario = useLive((s) => s.scenario);
  const serverTime = useLive((s) => s.serverTime);
  const delay = useLive((s) => s.delayMs) ?? 0;
  useTick(500);
  const running = scenario.state === 'running' && scenario.startedAt !== null;
  // Server clock estimate: the latest frame's stamp plus time since it arrived.
  const now = serverTime === null ? Date.now() : Date.now() - delay;
  const elapsed = running ? now - scenario.startedAt! : 0;
  return {
    scenario,
    running,
    elapsed,
    fraction: running ? Math.min(1, elapsed / scenario.durationMs) : 0,
  };
}

/** Shown to every viewer while a scenario runs: it is a simulation, and what part of it is real. */
export function ScenarioBadge() {
  const { scenario, running, elapsed } = useProgress();
  if (!running || !scenario.id) return null;
  const info = SCENARIOS[scenario.id];
  return (
    <div className="pointer-events-auto flex max-w-[92vw] animate-[rise_.4s_both] flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-critical/40 bg-[#160a0d]/95 px-3 py-2 text-xs text-hi">
      <span className="rounded-full bg-critical px-2 py-0.5 font-mono text-[0.62rem] font-semibold tracking-[0.12em] text-void uppercase">
        Simulation
      </span>
      <span className="font-medium">
        {info.title}
        {scenario.target ? ` · ${scenario.target}` : ''}
      </span>
      <span className="text-mid">{PHASE_TEXT[scenario.phase ?? ''] ?? scenario.phase}</span>
      <span className="font-mono text-mid tabular-nums">
        {clock(elapsed)} / {clock(scenario.durationMs)}
      </span>
      <span className="w-full text-[0.68rem] text-low">{info.note}</span>
    </div>
  );
}

const NETWORKS: [number, string][] = [
  [13335, 'Cloudflare'],
  [15169, 'Google'],
  [16509, 'Amazon'],
  [8075, 'Microsoft'],
  [3320, 'Deutsche Telekom'],
  [9498, 'Bharti Airtel'],
];
const COUNTRIES = ['US', 'DE', 'IN', 'BR', 'GB', 'FR', 'JP', 'NL', 'ZA', 'AU'];

/** The admin's control room: trigger a scenario or an attack on a chosen target, or stop it. */
export function ScenarioControls() {
  const role = useAuth((s) => s.user?.role);
  const selected = useUi((s) => s.selected);
  const { scenario, running, elapsed, fraction } = useProgress();
  const [problem, setProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<ScenarioId>('blackout');
  const [asn, setAsn] = useState('13335');
  const [cc, setCc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (role !== 'admin') return null;

  const info = SCENARIOS[pick];
  const country = cc ?? selected ?? 'DE';

  async function send(cmd: ScenarioCommand) {
    setProblem(null);
    setBusy(true);
    try {
      const res = await authFetch('/api/admin/scenario', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setProblem(body?.error?.message ?? `Failed (HTTP ${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  function start() {
    const cmd: ScenarioCommand = { action: 'start', scenario: pick };
    if (info.target === 'asn') cmd.asn = Number(asn);
    if (info.target === 'country') cmd.cc = country;
    void send(cmd);
  }

  return (
    <Panel
      title="Control room"
      aside={
        <span className="rounded border border-caution/40 px-1.5 font-mono text-[0.58rem] tracking-wider text-caution uppercase">
          admin
        </span>
      }
    >
      {running && scenario.id ? (
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-hi">{SCENARIOS[scenario.id].title}</div>
              <div className="text-[0.68rem] text-mid">{scenario.target ?? ''}</div>
            </div>
            <button
              type="button"
              onClick={() => void send({ action: 'stop' })}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-hi ring-1 ring-white/15 transition hover:bg-white/5"
            >
              ■ Stop
            </button>
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-critical transition-[width] duration-500"
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[0.62rem] text-mid">
            <span>{PHASE_TEXT[scenario.phase ?? ''] ?? scenario.phase}</span>
            <span>
              {clock(elapsed)} / {clock(scenario.durationMs)}
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1.5">
            {SCENARIO_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setPick(id)}
                className={`rounded-lg px-2 py-1.5 text-[0.7rem] transition ${
                  pick === id
                    ? 'bg-critical/15 text-hi ring-1 ring-critical/50'
                    : 'text-mid ring-1 ring-white/[0.08] hover:bg-white/[0.05]'
                }`}
              >
                {SCENARIOS[id].short}
              </button>
            ))}
          </div>
          <p className="text-[0.68rem] leading-relaxed text-low">{info.note}</p>
          {info.target === 'asn' && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-[0.7rem] text-mid">
                Network AS
                <input
                  value={asn}
                  onChange={(e) => setAsn(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  inputMode="numeric"
                  className="w-28 rounded-md bg-white/[0.05] px-2 py-1 font-mono text-xs text-hi ring-1 ring-white/10 outline-none focus:ring-signal/50"
                />
              </label>
              <div className="flex flex-wrap gap-1">
                {NETWORKS.map(([n, name]) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setAsn(String(n))}
                    className={`rounded-full px-2 py-0.5 text-[0.62rem] ring-1 transition ${asn === String(n) ? 'text-signal ring-signal/40' : 'text-low ring-white/[0.08] hover:text-hi'}`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {info.target === 'country' && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[0.7rem] text-mid">Country</span>
              {[...new Set([...(selected ? [selected] : []), ...COUNTRIES])].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCc(c)}
                  title={countryName(c)}
                  className={`rounded-full px-2 py-0.5 text-[0.62rem] ring-1 transition ${country === c ? 'text-signal ring-signal/40' : 'text-low ring-white/[0.08] hover:text-hi'}`}
                >
                  {flag(c)} {c}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={busy || (info.target === 'asn' && !asn)}
            onClick={start}
            className="w-full rounded-lg bg-critical py-2 text-xs font-semibold tracking-wide text-void uppercase transition hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Starting…' : `Launch ${info.short.toLowerCase()}`}
            {info.target === 'asn' && asn ? ` · AS${asn}` : ''}
            {info.target === 'country' ? ` · ${country}` : ''}
          </button>
        </div>
      )}
      <p className="mt-3 text-[0.62rem] leading-relaxed text-low">
        Everything injected is labelled as a simulation for every viewer and goes back to normal by
        itself.
      </p>
      {problem && <p className="mt-2 text-xs text-caution">{problem}</p>}
    </Panel>
  );
}
