import { useEffect, useRef } from 'react';
import { useLive } from '../store/live.ts';

const POINTS = 1600;
const PULSE_MS = 1700; // time for a pulse to cross the whole sphere
const WAVE_WIDTH = 0.16; // angular thickness of the wavefront, in radians
const TILT = 0.38; // lean the axis towards the viewer, in radians

interface Pulse {
  x: number;
  y: number;
  z: number;
  start: number;
}

/** Spread points evenly over a unit sphere (Fibonacci lattice). */
function buildSphere(count: number): Float32Array {
  const pts = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    pts[i * 3] = Math.cos(golden * i) * r;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = Math.sin(golden * i) * r;
  }
  return pts;
}

/**
 * A slowly turning sphere of points. Each heartbeat frame from the server
 * starts a wave at a random point that sweeps across the surface.
 *
 * It draws on a canvas inside its own animation-frame loop and listens to the
 * store directly, so a heartbeat never causes a React re-render here.
 */
export function PulseSphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const pts = buildSphere(POINTS);
    const pulses: Pulse[] = [];
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const unsubscribe = useLive.subscribe((state, prev) => {
      if (state.tick === prev.tick) return;
      // A random point on the sphere, in the sphere's own coordinates.
      const y = Math.random() * 2 - 1;
      const r = Math.sqrt(1 - y * y);
      const a = Math.random() * Math.PI * 2;
      pulses.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, start: performance.now() });
    });

    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);
    let raf = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      while (pulses.length > 0 && now - pulses[0]!.start > PULSE_MS) pulses.shift();

      const live = useLive.getState().status === 'live';
      const radius = Math.min(width, height) * 0.36; // leaves room for the halo
      const cx = width / 2;
      const cy = height / 2;
      const spin = reduceMotion ? 0.6 : now * 0.00011;
      const cosS = Math.cos(spin);
      const sinS = Math.sin(spin);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // A halo that swells from the rim on every beat.
      for (const pulse of pulses) {
        const p = (now - pulse.start) / PULSE_MS;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * (1.02 + p * 0.3), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(94, 230, 255, ${0.22 * (1 - p) ** 2})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      for (let i = 0; i < POINTS; i++) {
        const px = pts[i * 3]!;
        const py = pts[i * 3 + 1]!;
        const pz = pts[i * 3 + 2]!;

        // How strongly is this point lit by passing wavefronts?
        let glow = 0;
        for (const pulse of pulses) {
          const p = (now - pulse.start) / PULSE_MS;
          const angle = Math.acos(
            Math.max(-1, Math.min(1, px * pulse.x + py * pulse.y + pz * pulse.z)),
          );
          const d = (angle - p * Math.PI) / WAVE_WIDTH;
          glow += Math.exp(-d * d) * (1 - p);
        }

        // Spin around the vertical axis, then tilt, then project flat.
        const x1 = px * cosS + pz * sinS;
        const z1 = pz * cosS - px * sinS;
        const y2 = py * cosT - z1 * sinT;
        const depth = py * sinT + z1 * cosT; // +1 nearest, -1 farthest

        const near = (depth + 1) / 2;
        const base = (live ? 0.1 : 0.05) + near * near * (live ? 0.5 : 0.2);
        const size = 0.7 + near * 1.3 + glow * 1.6;

        ctx.globalAlpha = Math.min(1, base + glow * (0.35 + near * 0.65));
        ctx.fillStyle = glow > 0.35 ? '#e6fbff' : live ? '#5ee6ff' : '#55677a';
        ctx.fillRect(cx + x1 * radius - size / 2, cy - y2 * radius - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unsubscribe();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />;
}
