import { memo, useEffect, useRef } from 'react';
import { countryName } from '../geo.ts';
import { useFlip } from '../hooks/flip.ts';
import { useTick } from '../hooks/tick.ts';
import { navigate } from '../router.ts';
import { useGlobe } from '../store/globe.ts';
import { useWire, wire, type WireTone } from '../store/wire.ts';
import { flag } from '../theme.ts';

const TONE: Record<WireTone, string> = {
  critical: '#ff4d5e',
  warning: '#ffb454',
  calm: '#5ee6ff',
  radar: '#ff8c6e',
};

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false });

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
 * The wire: the latest happenings in a line, newest on the left. New items
 * push in and the older ones glide along; the line fades out at the right.
 */
export const Wire = memo(function Wire() {
  useLeaderWatch();
  const items = useWire((s) => s.items);
  useTick(10_000);
  const list = useFlip<HTMLOListElement>([items.map((i) => i.id).join()]);

  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex shrink-0 items-center gap-2 text-[0.78rem] text-low">
        <span className="size-1.5 animate-[blink_1.4s_ease-in-out_infinite] rounded-full bg-signal" />
        Wire
      </span>
      <ol
        ref={list}
        className="relative flex min-w-0 flex-1 items-center gap-6 overflow-hidden [mask-image:linear-gradient(90deg,#000_75%,transparent)]"
      >
        {items.length === 0 && (
          <li className="text-[0.82rem] whitespace-nowrap text-low">
            Quiet so far. New incidents, recoveries and Cloudflare reports appear here.
          </li>
        )}
        {items.map((item) => (
          <li key={item.id} data-flip={item.id} className="shrink-0">
            <button
              type="button"
              disabled={!item.href}
              onClick={() => item.href && navigate(item.href)}
              className="flex items-center gap-2 text-[0.84rem] whitespace-nowrap text-mid transition enabled:hover:text-hi"
            >
              <span className="size-1.5 rounded-full" style={{ background: TONE[item.tone] }} />
              <span className="font-mono text-[0.72rem] text-low">{clock(item.at)}</span>
              {item.text.length > 90 ? `${item.text.slice(0, 88)}…` : item.text}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
});
