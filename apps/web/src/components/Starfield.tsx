import { useEffect, useRef } from 'react';

/** A still field of faint stars behind the globe. Drawn once per resize, never animated. */
export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // A fixed seed, so the stars do not jump around on every resize.
      let seed = 7;
      const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      const count = Math.round((w * h) / 2600);
      for (let i = 0; i < count; i++) {
        const r = rand() < 0.94 ? 0.55 : 1.1;
        ctx.globalAlpha = 0.15 + rand() * 0.55;
        ctx.fillStyle = rand() < 0.85 ? '#cfe6ff' : '#9fe9ff';
        ctx.beginPath();
        ctx.arc(rand() * w, rand() * h, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="absolute inset-0 h-full w-full" />;
}
