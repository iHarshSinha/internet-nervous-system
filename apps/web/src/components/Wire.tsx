import { memo, useEffect, useRef } from 'react';
import { countryName } from '../geo.ts';
import { useFlip } from '../hooks/flip.ts';
import { useTick } from '../hooks/tick.ts';
import { navigate } from '../router.ts';
import { useGlobe } from '../store/globe.ts';
import { useWire, wire, type WireTone } from '../store/wire.ts';
import { flag } from '../theme.ts';
import { Panel } from './ui.tsx';

const TONE: Record<WireTone, string> = {
  critical: '#ff4d5e',
  warning: '#ffb454',
  calm: '#5ee6ff',
  radar: '#ff8c6e',
};

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }).slice(0, 5);

/** Puts a new busiest country on the wire when the leader changes (checked every few seconds). */
function useLeaderWatch() {
  const leader = useRef<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const top = [...useGlobe.getState().countries]
        .filter(([, c]) => (c.act ?? 0) > 0)
        .sort((a, b) => (b[1].act ?? 0) - (a[1].act ?? 0))[0];
      if (!top || top[0] === leader.current) return;
      const first = leader.current === null;
      leader.current = top[0];
      if (first) return; // the first reading is not news
      wire({
        id: `lead:${top[0]}:${Date.now()}`,
        text: `${flag(top[0])} ${countryName(top[0])} is now the busiest: ${top[1].act} route changes a second`,
        tone: 'calm',
        href: `/c/${top[0]}`,
      });
    }, 6000);
    return () => clearInterval(timer);
  }, []);
}

/**
 * Activity: the latest happenings, newest first (incidents opening, turning
 * critical and recovering, new Cloudflare reports, a new busiest country).
 * Folded by default; its summary shows the newest line.
 */
export const Activity = memo(function Activity() {
  useLeaderWatch();
  const items = useWire((s) => s.items);
  useTick(10_000);
  const list = useFlip<HTMLOListElement>([items.map((i) => i.id).join()]);
  const newest = items[0];

  return (
    <Panel
      title="Activity"
      collapsible
      defaultOpen={false}
      id="activity"
      aside={<span className="text-[0.86rem] text-low">newest first</span>}
      summary={
        <span className="block max-w-[11rem] truncate text-[0.86rem] text-low">
          {newest ? newest.text : 'quiet so far'}
        </span>
      }
    >
      {items.length === 0 ? (
        <p className="text-[0.92rem] text-mid">
          Quiet so far. New incidents, recoveries and Cloudflare reports appear here.
        </p>
      ) : (
        <ol ref={list} className="relative space-y-0.5">
          {items.map((item) => (
            <li key={item.id} data-flip={item.id}>
              <button
                type="button"
                disabled={!item.href}
                onClick={() => item.href && navigate(item.href)}
                className="flex w-full items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left transition enabled:hover:bg-white/[0.05]"
              >
                <span
                  className="mt-[0.45rem] size-1.5 shrink-0 rounded-full"
                  style={{ background: TONE[item.tone] }}
                />
                <span className="min-w-0 flex-1 text-[0.95rem] leading-snug text-mid">
                  {item.text}
                </span>
                <span className="shrink-0 pt-0.5 font-mono text-[0.74rem] text-low">
                  {clock(item.at)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
});
