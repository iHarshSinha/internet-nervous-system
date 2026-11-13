import { useEffect, useRef } from 'react';
import { useLive } from '../store/live.ts';

const POINTS = 2200;
const TILT = 0.42;
const ARC_MS = 1600;

interface Arc {
  a: [number, number, number];
  b: [number, number, number];
  start: number;
}

/** Points spread evenly over a unit sphere (a Fibonacci lattice). */
function lattice(n: number): Float32Array {
  const pts = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    pts[i * 3] = Math.cos(golden * i) * r;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = Math.sin(golden * i) * r;
  }
  return pts;
}

const randomOnSphere = (): [number, number, number] => {
  const y = Math.random() * 2 - 1;
  const r = Math.sqrt(1 - y * y);
  const t = Math.random() * Math.PI * 2;
  return [Math.cos(t) * r, y, Math.sin(t) * r];
};

/** Point along the great circle from a to b at t (0..1), lifted off the surface in the middle. */
function along(a: number[], b: number[], t: number): [number, number, number] {
  const dot = Math.max(-1, Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
  const omega = Math.acos(dot) || 1e-6;
  const s = Math.sin(omega);
  const k1 = Math.sin((1 - t) * omega) / s;
  const k2 = Math.sin(t * omega) / s;
  const lift = 1 + Math.sin(Math.PI * t) * 0.18 * omega;
  return [
    (a[0]! * k1 + b[0]! * k2) * lift,
    (a[1]! * k1 + b[1]! * k2) * lift,
    (a[2]! * k1 + b[2]! * k2) * lift,
  ];
}

/**
 * A slowly turning sphere of flat dots. Every second it fires arcs across
 * its surface in proportion to the real number of route changes the server
 * just measured, so the animation is a picture of live data, not decoration.
 * Canvas, no WebGL, no gradients.
 */
export function Orbit({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const pts = lattice(POINTS);
    const arcs: Arc[] = [];
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // Fire arcs for each second of real routing activity (capped so it stays readable).
    const fire = setInterval(() => {
      const world = useLive.getState().world;
      const changes = (world.ann ?? 0) + (world.wd ?? 0);
      const count = Math.min(9, Math.max(1, Math.round(Math.log2(changes + 1))));
      const now = performance.now();
      for (let i = 0; i < count; i++) {
        arcs.push({ a: randomOnSphere(), b: randomOnSphere(), start: now + Math.random() * 900 });
      }
    }, 1000);

    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);
    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const spin = reduce ? 0.8 : now * 0.00009;
      const cosS = Math.cos(spin);
      const sinS = Math.sin(spin);
      const radius = Math.min(w, h) * 0.38;
      const cx = w / 2;
      const cy = h / 2;
      const project = (x: number, y: number, z: number) => {
        const x1 = x * cosS + z * sinS;
        const z1 = z * cosS - x * sinS;
        const y2 = y * cosT - z1 * sinT;
        const depth = y * sinT + z1 * cosT;
        return { sx: cx + x1 * radius, sy: cy - y2 * radius, depth };
      };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // The sphere: front dots brighter and larger than back dots.
      for (let i = 0; i < POINTS; i++) {
        const p = project(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
        const near = (p.depth + 1) / 2;
        const size = 0.6 + near * 1.5;
        ctx.globalAlpha = 0.08 + near * near * 0.55;
        ctx.fillStyle = '#5ee6ff';
        ctx.fillRect(p.sx - size / 2, p.sy - size / 2, size, size);
      }

      // The arcs: a bright head travelling along a short tail.
      while (arcs.length > 0 && now - arcs[0]!.start > ARC_MS + 400) arcs.shift();
      for (const arc of arcs) {
        const t = (now - arc.start) / ARC_MS;
        if (t < 0 || t > 1.25) continue;
        const head = Math.min(1, t);
        const tail = Math.max(0, head - 0.35);
        ctx.beginPath();
        for (let s = 0; s <= 16; s++) {
          const q = along(arc.a, arc.b, tail + ((head - tail) * s) / 16);
          const p = project(q[0], q[1], q[2]);
          if (s === 0) ctx.moveTo(p.sx, p.sy);
          else ctx.lineTo(p.sx, p.sy);
        }
        const fade = t > 1 ? 1 - (t - 1) / 0.25 : 1;
        ctx.globalAlpha = 0.85 * fade;
        ctx.strokeStyle = '#ffb454';
        ctx.lineWidth = 1.3;
        ctx.stroke();
        const end = project(...along(arc.a, arc.b, head));
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#fff1d6';
        ctx.fillRect(end.sx - 1.5, end.sy - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(fire);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className={`block h-full w-full ${className}`} />;
}
