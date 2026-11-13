import { memo, useEffect } from 'react';
import { PulseSphere } from './components/PulseSphere.tsx';
import { startRealtime } from './realtime/client.ts';
import { useLive } from './store/live.ts';
import type { LinkStatus } from './workers/socket.worker.ts';

const STATUS: Record<LinkStatus, { label: string; dot: string; text: string }> = {
  connecting: {
    label: 'Connecting',
    dot: 'bg-caution animate-[blink_1s_ease-in-out_infinite]',
    text: 'text-caution',
  },
  live: {
    label: 'Live',
    dot: 'bg-signal shadow-[0_0_12px_var(--color-signal)]',
    text: 'text-signal',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-caution animate-[blink_1s_ease-in-out_infinite]',
    text: 'text-caution',
  },
};

const pad = (n: number) => String(n).padStart(2, '0');

export function utcClock(ms: number | null): string {
  if (ms === null) return '--:--:--';
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const StatusPill = memo(function StatusPill() {
  const status = useLive((s) => s.status);
  const { label, dot, text } = STATUS[status];
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 rounded-full border border-line bg-deep/70 px-3.5 py-1.5 backdrop-blur"
    >
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`font-mono text-xs tracking-[0.18em] uppercase ${text}`}>{label}</span>
    </div>
  );
});

function Readout({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0 border-l border-line pl-4">
      <dt className="text-[0.68rem] tracking-[0.2em] text-low uppercase">{label}</dt>
      <dd className="mt-1.5 truncate font-mono text-xl text-hi tabular-nums sm:text-2xl">
        {value}
        {unit && <span className="ml-1.5 text-sm text-mid">{unit}</span>}
      </dd>
    </div>
  );
}

const count = new Intl.NumberFormat('en-US');

// Each readout selects only the value it shows, so it re-renders only when that value changes.
const Readouts = memo(function Readouts() {
  const seq = useLive((s) => s.seq);
  const delayMs = useLive((s) => s.delayMs);
  const announced = useLive((s) => s.world.ann);
  const withdrawn = useLive((s) => s.world.wd);
  const p50 = useLive((s) => s.world.p50);
  const risLag = useLive((s) => s.sources.ris?.lag);
  const upstreams = useLive((s) => s.upstreams);
  const upstreamsUp = useLive((s) => s.upstreamsUp);
  const prefixes = useLive((s) => s.pipe.prefixes);
  const duplicates = useLive((s) => s.pipe.dup);
  const gaps = useLive((s) => s.stats.gaps);

  const num = (n: number | undefined) => (n === undefined ? '—' : count.format(n));

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4 lg:grid-cols-8">
      <Readout label="Routes announced" value={num(announced)} unit="/ s" />
      <Readout label="Routes withdrawn" value={num(withdrawn)} unit="/ s" />
      <Readout label="Median latency" value={p50 === undefined ? '—' : p50.toFixed(1)} unit="ms" />
      <Readout label="Prefixes known" value={num(prefixes)} />
      <Readout label="Duplicates dropped" value={num(duplicates)} />
      <Readout
        label="Routing feed delay"
        value={risLag === undefined || risLag === null ? '—' : risLag.toFixed(1)}
        unit="s"
      />
      <Readout
        label="Feeds connected"
        value={upstreams === null ? '—' : `${upstreamsUp ?? 0} / ${upstreams}`}
      />
      <Readout
        label={gaps === 0 ? 'Frame' : 'Frames missed'}
        value={gaps === 0 ? (seq === 0 ? '—' : `#${seq}`) : String(gaps)}
        unit={gaps === 0 && delayMs !== null ? `${delayMs} ms` : undefined}
      />
    </dl>
  );
});

export function App() {
  useEffect(startRealtime, []);

  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 px-5 pt-5 sm:px-8 sm:pt-7">
        <div className="flex items-center gap-3">
          <span className="relative grid size-7 place-items-center">
            <span className="absolute inset-0 rounded-full border border-signal/40" />
            <span className="size-2 rounded-full bg-signal" />
          </span>
          <span className="text-sm font-medium tracking-[0.22em] text-hi uppercase">
            Internet Nervous System
          </span>
        </div>
        <StatusPill />
      </header>

      {/* The sphere takes whatever height is left between the header and the headline. */}
      <div className="relative min-h-56 flex-1">
        <div
          aria-hidden="true"
          className="absolute -inset-x-10 -inset-y-24 -z-10 bg-[radial-gradient(closest-side,rgba(31,106,128,0.3),transparent)]"
        />
        <PulseSphere />
      </div>

      <section className="flex flex-col items-center px-5 pt-2 pb-10 text-center sm:px-8">
        <h1 className="max-w-[18ch] text-4xl font-semibold tracking-tight text-balance text-hi sm:text-6xl">
          The internet has a pulse.
        </h1>
        <p className="mt-4 max-w-[56ch] text-base text-pretty text-mid sm:text-lg">
          Live now: every routing change and latency measurement below is real, read from RIPE RIS
          and RIPE Atlas, counted on our server and pushed to this page through Socket.IO once a
          second.
        </p>
      </section>

      <footer className="border-t border-line bg-deep/60 px-5 py-6 backdrop-blur sm:px-8">
        <Readouts />
      </footer>
    </main>
  );
}
