import { REPLAY_SCENARIOS } from '@ins/shared';
import { useLive } from '../store/live.ts';

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
      <span className="rounded-full bg-caution px-2 py-0.5 font-mono text-[0.74rem] font-semibold tracking-[0.12em] text-void uppercase">
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
