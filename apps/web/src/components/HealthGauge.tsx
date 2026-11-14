import { useEffect, useState } from 'react';
import { healthColor, healthLabel } from '../theme.ts';
import { AnimatedNumber } from './AnimatedNumber.tsx';

/** A ring that fills with the health score, in the health colour. */
export function HealthGauge({ value, size = 148 }: { value: number | undefined; size?: number }) {
  const stroke = 9;
  const r = (size - stroke) / 2 - 6;
  const c = 2 * Math.PI * r;
  // Start empty and sweep to the value once on screen, so the ring fills as the page opens.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  const filled = !shown || value === undefined ? 0 : Math.max(0, Math.min(100, value)) / 100;
  const color = healthColor(value);

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - filled)}
          style={{
            transition: 'stroke-dashoffset 1400ms cubic-bezier(.2,.8,.2,1), stroke 600ms',
            filter: `drop-shadow(0 0 10px ${healthColor(value, 0.45)})`,
          }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-mono text-4xl font-medium tabular-nums" style={{ color }}>
          <AnimatedNumber value={value} durationMs={1400} />
        </div>
        <div className="text-[0.74rem] tracking-[0.1em] text-mid uppercase">
          {healthLabel(value)}
        </div>
      </div>
    </div>
  );
}
