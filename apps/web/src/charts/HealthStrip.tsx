import { healthScore } from '@ins/shared';
import { useEffect, useRef } from 'react';
import { getSeries, useSeries, type Point } from '../store/series.ts';
import { healthColor } from '../theme.ts';

const DAY = 24 * 3600_000;

/** Health of a stored or live minute. */
export function minuteHealth(p: Point): number | undefined {
  if (p.health !== undefined) return p.health;
  if (p.ann === undefined && p.pings === undefined) return undefined;
  return healthScore({ ann: p.ann ?? 0, wd: p.wd ?? 0, pings: p.pings ?? 0, lost: p.lost ?? 0 });
}

/**
 * One thin bar per minute of the last 24 hours, coloured by health: a day's
 * story at a glance. Drawn on a canvas, at most once per animation frame.
 */
export function HealthStrip({ room, height = 36 }: { room: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, 0, w, h);

      const s = getSeries(room);
      if (!s) return;
      const end = Date.now();
      const start = end - DAY;
      const bar = Math.max(1, w / 1440);
      for (const [t, p] of s.minutes) {
        if (t < start) continue;
        const health = minuteHealth(p);
        if (health === undefined) continue;
        ctx.fillStyle = healthColor(health, 0.85);
        ctx.fillRect(((t - start) / DAY) * w, 0, bar, h);
      }
    };
    const unsubscribe = useSeries.subscribe(() => {
      raf ||= requestAnimationFrame(draw);
    });
    raf = requestAnimationFrame(draw);
    const observer = new ResizeObserver(() => (raf ||= requestAnimationFrame(draw)));
    observer.observe(canvas);
    return () => {
      unsubscribe();
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [room]);

  return <canvas ref={ref} className="block w-full rounded-md" style={{ height }} />;
}
