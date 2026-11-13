import { healthColor, healthLabel } from '../theme.ts';

/** A ring that fills with the health score, in the health colour. */
export function HealthGauge({ value, size = 148 }: { value: number | undefined; size?: number }) {
  const stroke = 9;
  const r = (size - stroke) / 2 - 6;
  const c = 2 * Math.PI * r;
  const filled = value === undefined ? 0 : Math.max(0, Math.min(100, value)) / 100;
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
            transition: 'stroke-dashoffset 900ms cubic-bezier(.2,.8,.2,1), stroke 600ms',
            filter: `drop-shadow(0 0 10px ${healthColor(value, 0.45)})`,
          }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-mono text-4xl font-medium tabular-nums" style={{ color }}>
          {value ?? '—'}
        </div>
        <div className="text-[0.62rem] tracking-[0.18em] text-mid uppercase">
          {healthLabel(value)}
        </div>
      </div>
    </div>
  );
}
