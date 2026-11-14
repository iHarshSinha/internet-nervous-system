import { useEffect, useState } from 'react';
import { perfSnapshot, type PerfSnapshot } from '../perf.ts';
import { syncClock, useClock } from '../realtime/clock.ts';
import { navigate } from '../router.ts';
import { useLive } from '../store/live.ts';

const KEY = 'ins:hud';

function savedOpen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The HUD: this browser's own numbers, on any page. Press ~ (or `) to show
 * or hide it. It is what proves the page keeps up: frames drawn, frames
 * skipped, server frames received, how long applying them takes, and how
 * old a frame is when it arrives, corrected for the difference between the
 * two clocks.
 */
export function Hud() {
  const [open, setOpen] = useState(savedOpen);
  const [p, setP] = useState<PerfSnapshot | null>(null);
  const status = useLive((s) => s.status);
  const stats = useLive((s) => s.stats);
  const delayMs = useLive((s) => s.delayMs);
  const { offsetMs, rttMs } = useClock();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select');
      if (typing || (e.key !== '~' && e.key !== '`')) return;
      setOpen((o) => {
        try {
          localStorage.setItem(KEY, o ? '0' : '1');
        } catch {
          // Storage unavailable: the toggle still works for this visit.
        }
        return !o;
      });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    void syncClock();
    const clock = setInterval(() => void syncClock(), 60_000);
    const tick = setInterval(() => setP(perfSnapshot()), 500);
    return () => {
      clearInterval(clock);
      clearInterval(tick);
    };
  }, [open]);

  if (!open) return null;
  // Frame age: our clock when applied minus the server's stamp, plus how far ahead the server's clock is.
  const age = delayMs === null ? null : delayMs + (offsetMs ?? 0);
  const row = (label: string, value: string, warn = false) => (
    <div className="flex justify-between gap-4">
      <span className="text-low">{label}</span>
      <span className={`tabular-nums ${warn ? 'text-caution' : 'text-hi'}`}>{value}</span>
    </div>
  );

  return (
    <div
      role="status"
      aria-label="Performance HUD"
      className="glass fixed bottom-4 left-4 z-50 w-60 rounded-lg p-3 font-mono text-[0.78rem] leading-relaxed shadow-xl"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="tracking-widest text-mid uppercase">HUD</span>
        <span className="text-low">~ to hide</span>
      </div>
      {row('FPS', p ? String(p.fps) : '…', p !== null && p.fps < 50)}
      {row('Frames skipped /s', p ? String(p.dropped) : '…', (p?.dropped ?? 0) > 5)}
      {row('Server frames /s', p ? String(p.framesPerSec) : '…')}
      {row('Renders /s', p ? String(p.appliesPerSec) : '…')}
      {row('Apply p95', p ? `${p.applyP95Ms} ms` : '…', (p?.applyP95Ms ?? 0) > 8)}
      {row('Long tasks', p ? `${p.longTasks} (${p.longTaskMs} ms)` : '…')}
      <div className="my-1.5 h-px bg-line" />
      {row('Link', status)}
      {row('Frame age', age === null ? '…' : `${age} ms`, (age ?? 0) > 1500)}
      {row(
        'Clock offset',
        offsetMs === null
          ? '…'
          : `${offsetMs > 0 ? '+' : ''}${offsetMs} ms ±${Math.ceil((rttMs ?? 0) / 2)}`,
      )}
      {row('Gaps · resyncs', `${stats.gaps} · ${stats.resyncs}`, stats.gaps > 0)}
      {row('Duplicates', String(stats.duplicates))}
      <button
        type="button"
        onClick={() => navigate('/ops')}
        className="mt-2 text-signal hover:underline"
      >
        Server numbers →
      </button>
    </div>
  );
}
