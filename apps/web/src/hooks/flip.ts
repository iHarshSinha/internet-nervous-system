import { useLayoutEffect, useRef } from 'react';

/**
 * Rows that glide to their new place when a ranking changes, instead of
 * jumping ("FLIP": measure First, render Last, Invert with a transform, Play
 * the transition back to zero). Put `data-flip="<key>"` on each row and the
 * returned ref on their container. No library, and no React re-renders: it
 * only touches `transform` on the rows that moved.
 */
export function useFlip<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);
  const last = useRef(new Map<string, [number, number]>());

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const rows = [...box.querySelectorAll<HTMLElement>('[data-flip]')];
    const now = new Map<string, [number, number]>();
    for (const row of rows) {
      const key = row.dataset.flip!;
      const pos: [number, number] = [row.offsetLeft, row.offsetTop];
      now.set(key, pos);
      const before = last.current.get(key);
      if (before === undefined) {
        // A newcomer slides in from the side.
        row.animate(
          [
            { opacity: 0, transform: 'translateX(-14px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      } else if (before[0] !== pos[0] || before[1] !== pos[1]) {
        const [dx, dy] = [before[0] - pos[0], before[1] - pos[1]];
        row.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
          duration: 520,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        });
      }
    }
    last.current = now;
    // The caller decides when the list may have changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
