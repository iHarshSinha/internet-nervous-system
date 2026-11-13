import {
  REPLAY_SCENARIOS,
  REPLAY_SPEEDS,
  type ReplayCommand,
  type ReplayScenario,
} from '@ins/shared';
import { useState } from 'react';
import { authFetch, useAuth } from '../store/auth.ts';
import { useLive } from '../store/live.ts';
import { Panel } from './ui.tsx';

const pad = (n: number) => String(n).padStart(2, '0');
function utc(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Shown to everyone while a recording plays: what it is, when in the original
 * day we are, and how fast. Recorded data is never passed off as live.
 */
export function ReplayBadge() {
  const replay = useLive((s) => s.replay);
  if (replay.state !== 'playing' && replay.state !== 'paused' && replay.state !== 'loading')
    return null;
  const scenario = replay.scenario ? REPLAY_SCENARIOS[replay.scenario] : null;
  return (
    <div className="pointer-events-auto flex animate-[rise_.4s_both] items-center gap-3 rounded-full border border-caution/40 bg-[#140f07]/95 py-1.5 pr-4 pl-2 text-xs text-hi">
      <span className="rounded-full bg-caution px-2 py-0.5 font-mono text-[0.62rem] font-semibold tracking-[0.12em] text-void uppercase">
        {replay.state === 'paused' ? '❚❚ Replay' : '▶ Replay'}
      </span>
      <span className="text-mid">{scenario?.title ?? 'Recorded data'}</span>
      <span className="font-mono tabular-nums">
        {replay.clock ? `${utc(replay.clock)} UTC` : '…'}
      </span>
      <span className="font-mono text-caution">{replay.speed}×</span>
    </div>
  );
}

/** The admin's replay controls: start the Facebook outage, pause, change speed, stop. */
export function ReplayControls() {
  const role = useAuth((s) => s.user?.role);
  const replay = useLive((s) => s.replay);
  const [problem, setProblem] = useState<string | null>(null);
  const [scenario] = useState<ReplayScenario>('facebook-2021');
  if (role !== 'admin') return null;

  const info = REPLAY_SCENARIOS[scenario];
  const active =
    replay.state === 'playing' || replay.state === 'paused' || replay.state === 'loading';
  const progress =
    replay.clock && active
      ? Math.min(1, Math.max(0, (replay.clock - info.defaultFrom) / (info.end - info.defaultFrom)))
      : 0;
  const incidentMark = (info.incidentAt - info.defaultFrom) / (info.end - info.defaultFrom);

  async function send(cmd: ReplayCommand) {
    setProblem(null);
    const res = await authFetch('/api/admin/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: string | { message?: string };
    } | null;
    if (!res.ok)
      setProblem(typeof body?.error === 'object' ? (body.error.message ?? 'Failed') : 'Failed');
    else if (typeof body?.error === 'string') setProblem(body.error);
  }

  const button = 'rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition disabled:opacity-40';

  return (
    <Panel
      title="Control room · replay"
      aside={
        <span className="rounded border border-caution/40 px-1.5 font-mono text-[0.58rem] tracking-wider text-caution uppercase">
          admin
        </span>
      }
    >
      <div className="text-sm text-hi">{info.title}</div>
      <div className="mt-0.5 text-[0.7rem] text-mid">
        Real routing data from four RIPE RIS collectors, replayed through the live pipeline.
      </div>

      <div className="relative mt-3 h-1.5 rounded-full bg-white/[0.06]">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-caution"
          style={{ width: `${progress * 100}%` }}
        />
        <span
          className="absolute -top-1 h-3.5 w-px bg-critical"
          style={{ left: `${incidentMark * 100}%` }}
          title="Withdrawals begin, 15:39 UTC"
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[0.6rem] text-low">
        <span>{utc(info.defaultFrom)}</span>
        <span className="text-critical">15:39 outage</span>
        <span>{utc(info.end)}</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!active ? (
          <button
            type="button"
            className={`${button} bg-caution text-void ring-caution`}
            onClick={() =>
              void send({ action: 'start', scenario, speed: replay.speed > 1 ? replay.speed : 10 })
            }
          >
            ▶ Play outage
          </button>
        ) : replay.state === 'paused' ? (
          <button
            type="button"
            className={`${button} text-hi ring-white/15 hover:bg-white/5`}
            onClick={() => void send({ action: 'resume' })}
          >
            ▶ Resume
          </button>
        ) : (
          <button
            type="button"
            className={`${button} text-hi ring-white/15 hover:bg-white/5`}
            onClick={() => void send({ action: 'pause' })}
          >
            ❚❚ Pause
          </button>
        )}
        <button
          type="button"
          disabled={!active}
          className={`${button} text-mid ring-white/10 hover:bg-white/5`}
          onClick={() => void send({ action: 'stop' })}
        >
          ■ Stop
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[0.62rem] tracking-[0.14em] text-low uppercase">Speed</span>
        {REPLAY_SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            onClick={() => void send({ action: 'speed', speed })}
            className={`rounded-md px-2 py-0.5 font-mono text-[0.68rem] transition ${
              replay.speed === speed
                ? 'bg-caution/15 text-caution ring-1 ring-caution/40'
                : 'text-mid hover:text-hi'
            }`}
          >
            {speed}×
          </button>
        ))}
      </div>
      {replay.state === 'finished' && (
        <p className="mt-2 text-xs text-mid">Finished. Play again any time.</p>
      )}
      {problem && <p className="mt-2 text-xs text-caution">{problem}</p>}
    </Panel>
  );
}
