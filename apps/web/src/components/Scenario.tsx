import { SCENARIOS, type ScenarioCommand, type ScenarioId } from '@ins/shared';
import { useState } from 'react';
import { useTick } from '../hooks/tick.ts';
import { authFetch, useAuth } from '../store/auth.ts';
import { useLive } from '../store/live.ts';
import { Panel } from './ui.tsx';

const PHASE_TEXT: Record<string, string> = {
  priming: 'Setting the scene',
  outage: 'Routes being withdrawn',
  gone: 'Network unreachable',
  recovery: 'Coming back (simulated)',
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
      <span className="font-medium">{info.title}</span>
      <span className="text-mid">{PHASE_TEXT[scenario.phase ?? ''] ?? scenario.phase}</span>
      <span className="font-mono text-mid tabular-nums">
        {clock(elapsed)} / {clock(scenario.durationMs)}
      </span>
      <span className="w-full text-[0.68rem] text-low">{info.note}</span>
    </div>
  );
}

/** The admin's trigger: start a scenario now, or stop it early. */
export function ScenarioControls() {
  const role = useAuth((s) => s.user?.role);
  const { scenario, running, elapsed, fraction } = useProgress();
  const [problem, setProblem] = useState<string | null>(null);
  if (role !== 'admin') return null;

  async function send(cmd: ScenarioCommand) {
    setProblem(null);
    const res = await authFetch('/api/admin/scenario', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setProblem(body?.error?.message ?? `Failed (HTTP ${res.status})`);
    }
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
      {(Object.keys(SCENARIOS) as ScenarioId[]).map((id) => {
        const info = SCENARIOS[id];
        const active = running && scenario.id === id;
        return (
          <div key={id}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-hi">{info.title}</div>
                <div className="text-[0.68rem] text-mid">
                  AS{info.asn} · about 2 minutes, then back to normal
                </div>
              </div>
              {active ? (
                <button
                  type="button"
                  onClick={() => void send({ action: 'stop' })}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-hi ring-1 ring-white/15 transition hover:bg-white/5"
                >
                  ■ Stop
                </button>
              ) : (
                <button
                  type="button"
                  disabled={running}
                  onClick={() => void send({ action: 'start', scenario: id })}
                  className="rounded-lg bg-critical px-3 py-1.5 text-xs font-semibold text-void transition hover:brightness-110 disabled:opacity-40"
                >
                  Trigger outage
                </button>
              )}
            </div>
            {active && (
              <div className="mt-3">
                <div className="h-1.5 rounded-full bg-white/[0.06]">
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
            )}
          </div>
        );
      })}
      <p className="mt-3 text-[0.66rem] leading-relaxed text-low">
        Injects real recorded routing data into the live stream, labelled as a simulation for every
        viewer. More attack types arrive with the detectors.
      </p>
      {problem && <p className="mt-2 text-xs text-caution">{problem}</p>}
    </Panel>
  );
}
