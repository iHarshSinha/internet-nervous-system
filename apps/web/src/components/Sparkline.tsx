import { useEffect, useRef } from 'react';
import { useGlobe } from '../store/globe.ts';
import { colors } from '../theme.ts';

/**
 * The world's route changes per second over the last two minutes. Drawn on a
 * canvas from the store, at most once per animation frame, without React.
 */
export function Sparkline({ height = 56 }: { height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;

    const draw = () => {
      raf = 0;
      const pts = useGlobe.getState().worldSeconds;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr) canvas.width = w * dpr;
      if (canvas.height !== h * dpr) canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (pts.length < 2) return;

      const max = Math.max(...pts.map((p) => p.ann + p.wd), 1);
      const x = (i: number) => (i / (120 - 1)) * w + (120 - pts.length) * (w / 119);
      const y = (v: number) => h - 2 - (v / max) * (h - 6);

      const line = (value: (p: (typeof pts)[number]) => number, stroke: string, fill: string) => {
        ctx.beginPath();
        pts.forEach((p, i) =>
          i === 0 ? ctx.moveTo(x(i), y(value(p))) : ctx.lineTo(x(i), y(value(p))),
        );
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.lineTo(x(pts.length - 1), h);
        ctx.lineTo(x(0), h);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, fill);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fill();
      };
      line((p) => p.ann + p.wd, colors.announce, 'rgba(94,230,255,0.28)');
      line((p) => p.wd, colors.withdraw, 'rgba(255,180,84,0.22)');
    };

    const unsubscribe = useGlobe.subscribe(() => {
      raf ||= requestAnimationFrame(draw);
    });
    raf = requestAnimationFrame(draw);
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="block w-full" style={{ height }} />;
}
