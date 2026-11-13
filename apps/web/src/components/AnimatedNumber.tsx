import { useEffect, useRef } from 'react';
import { formatInt } from '../theme.ts';

/**
 * A number that glides to its new value instead of jumping. It writes to the
 * DOM directly from an animation frame, so the tween never re-renders React.
 */
export function AnimatedNumber({
  value,
  format = formatInt,
  durationMs = 450,
}: {
  value: number | undefined;
  format?: (n: number) => string;
  durationMs?: number;
}) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | undefined>(undefined);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    if (value === undefined) {
      node.textContent = '—';
      return;
    }
    const from = shown.current ?? value;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      const current = from + (value - from) * eased;
      shown.current = current;
      node.textContent = format(Math.round(current));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, format, durationMs]);

  return <span ref={el}>—</span>;
}
