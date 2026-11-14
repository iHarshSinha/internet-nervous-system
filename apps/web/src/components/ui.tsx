import { memo, useEffect, useState, type ReactNode } from 'react';
import { navigate } from '../router.ts';
import { formatTime, localZoneName, toggleZone, useClockZone, zoneLabel } from '../time.ts';
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
    <div
      role="status"
      className="glass flex items-center gap-2 rounded-full px-2.5 py-1.5 sm:gap-2.5 sm:px-3.5"
    >
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`font-mono text-xs tracking-[0.1em] uppercase max-sm:sr-only ${text}`}>
        {label}
      </span>
    </div>
  );
});

/**
 * The clock, so viewers (and the video) can see the data is happening now.
 * Your own time zone by default; click it for UTC (the internet's time) and back.
 */
export function Clock() {
  const [now, setNow] = useState(() => Date.now());
  const local = useClockZone((s) => s.local);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <button
      type="button"
      onClick={toggleZone}
      title={
        local
          ? `Your local time (${localZoneName}). Click to show UTC.`
          : 'UTC. Click to show your local time.'
      }
      className="font-mono text-[0.86rem] tracking-[0.08em] text-mid tabular-nums transition hover:text-hi"
    >
      {formatTime(now, true)}
      <span className="ml-1.5 text-low">{zoneLabel()}</span>
    </button>
  );
}

export function Header() {
  return (
    <header className="pointer-events-none relative z-20 flex items-center justify-between gap-4 px-4 pt-4 sm:px-7 sm:pt-6">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="pointer-events-auto min-w-0 text-left"
      >
        <span className="block font-display text-[0.82rem] leading-none tracking-[0.12em] whitespace-nowrap text-hi uppercase max-sm:text-[0.6rem] max-sm:tracking-[0.08em]">
          <span className="max-sm:hidden">Internet Nervous System</span>
          <span className="sm:hidden">Nervous System</span>
        </span>
      </button>
      <div className="pointer-events-auto flex shrink-0 items-center gap-2 sm:gap-4">
        <span className="hidden sm:inline">
          <Clock />
        </span>
        <StatusPill />
        <Account />
      </div>
    </header>
  );
}

/** Read and remember a section's open state (per viewer, in this browser only). */
function useOpen(id: string | undefined, initial: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    if (!id) return initial;
    try {
      const saved = localStorage.getItem(`ins:open:${id}`);
      return saved === null ? initial : saved === '1';
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        if (id) localStorage.setItem(`ins:open:${id}`, o ? '0' : '1');
      } catch {
        // Storage can be unavailable (private windows); the section still works.
      }
      return !o;
    });
  return [open, toggle];
}

/**
 * A panel. With `collapsible`, its title is a button that folds the body
 * away, so the screen shows only what the viewer has chosen to see. `id`
 * remembers the choice; `summary` is a one-line glance shown while closed.
 */
export function Panel({
  title,
  aside,
  children,
  className = '',
  collapsible = false,
  defaultOpen = true,
  id,
  summary,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  id?: string;
  summary?: ReactNode;
}) {
  const [open, toggle] = useOpen(id, defaultOpen);
  const isOpen = !collapsible || open;
  return (
    <section className={`glass rounded-lg ${className}`}>
      {title &&
        (collapsible ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="group flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <span
              aria-hidden="true"
              className={`text-xs text-low transition-transform duration-300 group-hover:text-hi ${open ? 'rotate-90' : ''}`}
            >
              ▸
            </span>
            <h2 className="title flex-1">{title}</h2>
            <span className="text-[0.86rem] text-mid">{open ? aside : (summary ?? aside)}</span>
          </button>
        ) : (
          <header className="flex items-baseline justify-between gap-3 px-4 pt-3.5 pb-1">
            <h2 className="title">{title}</h2>
            {aside}
          </header>
        ))}
      {/* Rows 0fr -> 1fr animates the height without measuring it. */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={`px-4 pb-4 ${title ? 'pt-2' : 'pt-4'}`}>{children}</div>
        </div>
      </div>
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
      <div className="label">{label}</div>
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
