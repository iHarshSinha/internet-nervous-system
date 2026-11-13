import { memo, useEffect, useState, type ReactNode } from 'react';
import { navigate } from '../router.ts';
import { Account } from './Account.tsx';
import { useLive } from '../store/live.ts';
import type { LinkStatus } from '../workers/socket.worker.ts';

const STATUS: Record<LinkStatus, { label: string; dot: string; text: string }> = {
  connecting: {
    label: 'Connecting',
    dot: 'bg-caution animate-[blink_1s_ease-in-out_infinite]',
    text: 'text-caution',
  },
  live: {
    label: 'Live',
    dot: 'bg-signal shadow-[0_0_12px_var(--color-signal)] animate-[breathe_2.4s_ease-in-out_infinite]',
    text: 'text-signal',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-caution animate-[blink_1s_ease-in-out_infinite]',
    text: 'text-caution',
  },
};

export const StatusPill = memo(function StatusPill() {
  const status = useLive((s) => s.status);
  const { label, dot, text } = STATUS[status];
  return (
    <div role="status" className="glass flex items-center gap-2.5 rounded-full px-3.5 py-1.5">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`font-mono text-xs tracking-[0.18em] uppercase ${text}`}>{label}</span>
    </div>
  );
});

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC clock, so viewers (and the video) can see the data is happening now. */
export function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="font-mono text-xs tracking-[0.12em] text-mid tabular-nums">
      {pad(now.getUTCHours())}:{pad(now.getUTCMinutes())}:{pad(now.getUTCSeconds())}
      <span className="ml-1 text-low">UTC</span>
    </span>
  );
}

export function Header() {
  return (
    <header className="pointer-events-none relative z-20 flex items-center justify-between gap-4 px-4 pt-4 sm:px-7 sm:pt-6">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="pointer-events-auto flex items-center gap-3 text-left"
      >
        <span className="relative grid size-8 place-items-center">
          <span className="absolute inset-0 rounded-full border border-signal/40 animate-[ring_3s_ease-out_infinite]" />
          <span className="absolute inset-1.5 rounded-full border border-signal/25" />
          <span className="size-2 rounded-full bg-signal shadow-[0_0_14px_var(--color-signal)]" />
        </span>
        <span className="leading-tight">
          <span className="block text-[0.8rem] font-semibold tracking-[0.24em] text-hi uppercase">
            Internet Nervous System
          </span>
          <span className="hidden text-[0.7rem] tracking-[0.08em] text-low sm:block">
            The internet&apos;s routing and latency, live
          </span>
        </span>
      </button>
      <div className="pointer-events-auto flex items-center gap-4">
        <span className="hidden sm:inline">
          <UtcClock />
        </span>
        <StatusPill />
        <Account />
      </div>
    </header>
  );
}

export function Panel({
  title,
  aside,
  children,
  className = '',
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`glass rounded-2xl p-4 ${className}`}>
      {title && (
        <header className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-[0.68rem] font-medium tracking-[0.22em] text-mid uppercase">
            {title}
          </h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  tone,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[0.66rem] tracking-[0.18em] text-low uppercase">{label}</div>
      <div
        className="mt-1 truncate font-mono text-lg text-hi tabular-nums"
        style={tone ? { color: tone } : undefined}
      >
        {value}
        {unit && <span className="ml-1 text-xs text-mid">{unit}</span>}
      </div>
    </div>
  );
}
