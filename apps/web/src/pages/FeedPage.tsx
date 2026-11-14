import { rooms, type EventKind, type FeedEvent } from '@ins/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { VirtualList } from '../components/VirtualList.tsx';
import { countryName, loadCountries } from '../geo.ts';
import { subscribe, unsubscribe } from '../realtime/client.ts';
import { navigate } from '../router.ts';
import { useFeed } from '../store/feed.ts';
import { useLive } from '../store/live.ts';
import { flag, formatInt } from '../theme.ts';
import { formatTime, zoneLabel } from '../time.ts';

const KINDS: { kind: EventKind | '*'; label: string }[] = [
  { kind: '*', label: 'Everything' },
  { kind: 'bgp.announce', label: 'Announcements' },
  { kind: 'bgp.withdraw', label: 'Withdrawals' },
  { kind: 'atlas.ping', label: 'Pings' },
  { kind: 'atlas.probe_status', label: 'Probes' },
];

/** Phones: time, type, country, prefix with the detail under it. Wider: six columns. */
const GRID =
  'grid grid-cols-[4.3rem_3.2rem_1.6rem_minmax(0,1fr)] gap-2 sm:grid-cols-[4.6rem_3.6rem_2.6rem_minmax(0,11rem)_minmax(0,1fr)_3.4rem]';

const TAG: Partial<Record<EventKind, { text: string; color: string; hint: string }>> = {
  'bgp.announce': { text: 'ANN', color: '#5ee6ff', hint: 'A network announced a route' },
  'bgp.withdraw': { text: 'WD', color: '#ffb454', hint: 'A route was withdrawn' },
  'bgp.peer_state': { text: 'PEER', color: '#a6a9af', hint: 'A router session changed' },
  'atlas.ping': { text: 'PING', color: '#9b8cff', hint: 'A RIPE Atlas probe measured latency' },
  'atlas.probe_status': { text: 'PROBE', color: '#d78cff', hint: 'A probe came or went' },
};

/** What the row says about the event, in one line. */
function detail(e: FeedEvent): string {
  if (e.k === 'bgp.announce') {
    const path = e.path?.join(' ') ?? '';
    return `${e.asn !== null ? `AS${e.asn}` : ''}${path ? `  via ${path}` : ''}`;
  }
  if (e.k === 'bgp.withdraw') return e.asn !== null ? `was AS${e.asn}` : 'origin unknown';
  if (e.k === 'atlas.ping')
    return e.rtt === null || e.rtt === undefined ? 'no reply' : `${e.rtt.toFixed(1)} ms`;
  if (e.k === 'atlas.probe_status') return e.ev ?? '';
  return '';
}

function Row({ e }: { e: FeedEvent }) {
  const tag = TAG[e.k];
  const what = e.p ?? (e.prb !== undefined ? `probe ${e.prb}` : '');
  return (
    <div
      className={`${GRID} items-center border-b border-line/50 px-3 py-2 font-mono text-[0.8rem] sm:text-[0.86rem]`}
    >
      <span className="text-low tabular-nums">{formatTime(e.t, true)}</span>
      <span
        title={tag?.hint}
        className="w-fit rounded px-1.5 py-0.5 text-[0.72rem] tracking-wider"
        style={{ color: tag?.color, background: `${tag?.color ?? '#888'}1a` }}
      >
        {tag?.text ?? e.k}
      </span>
      <span title={e.cc ? countryName(e.cc) : 'Country unknown'}>
        {e.cc ? `${flag(e.cc)}` : <span className="text-low">··</span>}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-hi">{what}</span>
        <span className="block truncate text-[0.74rem] text-mid sm:hidden">{detail(e)}</span>
      </span>
      <span className="hidden truncate text-mid sm:block">
        {detail(e)}
        {e.sim && <span className="ml-2 text-[0.72rem] text-low uppercase">simulated</span>}
      </span>
      <span className="hidden truncate text-right text-low sm:block">{e.col ?? e.src}</span>
    </div>
  );
}

/**
 * The firehose: raw events as they arrive, for one type and country.
 *
 * It is a SAMPLE: at most 20 rows a second however busy the room is, picked
 * fairly from all its events, and thinned further if the server is under
 * load. The counter shows how many events there really were. The list is
 * virtualised, so 500 rows cost no more to draw than the dozen in view.
 */
export function FeedPage() {
  const [kind, setKind] = useState<EventKind | '*'>('*');
  const [cc, setCc] = useState('*');
  const [codes, setCodes] = useState<string[]>([]);
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);
  const events = useFeed((s) => s.events);
  const perSecond = useFeed((s) => s.perSecond);
  const shown = useFeed((s) => s.shown);
  const total = useFeed((s) => s.total);
  const queue = useLive((s) => s.queue);
  const totalAtPause = useRef(0);
  // Resuming starts the list again from the top (a fresh list, scrolled to the newest row).
  const [resumes, setResumes] = useState(0);
  const room = rooms.feed(kind, cc);

  useEffect(() => {
    void loadCountries().then((all) =>
      setCodes(
        all
          .map((f) => f.properties.cc)
          .sort((a, b) => countryName(a).localeCompare(countryName(b))),
      ),
    );
  }, []);

  // One feed room at a time: leave the old one before joining the new.
  useEffect(() => {
    useFeed.getState().clear();
    setFrozen(null);
    void subscribe([room]);
    return () => unsubscribe([room]);
  }, [room]);

  const pause = () => {
    totalAtPause.current = useFeed.getState().total;
    setFrozen(useFeed.getState().events);
  };
  const rows = frozen ?? events;
  const waiting = frozen ? total - totalAtPause.current : 0;
  const sampling = queue.pressure && queue.pressure !== 'normal';
  const share = total > 0 ? Math.round((shown / total) * 1000) / 10 : 100;

  const header = useMemo(
    () => (
      <div className={`${GRID} border-b border-line px-3 pb-2 text-[0.78rem] text-low uppercase`}>
        <span>{zoneLabel()}</span>
        <span>type</span>
        <span>cc</span>
        <span>prefix / probe</span>
        <span className="hidden sm:block">detail</span>
        <span className="hidden text-right sm:block">from</span>
      </div>
    ),
    [],
  );

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 pt-24 pb-10 sm:px-8">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="text-[0.92rem] text-mid hover:text-hi"
      >
        ← Globe
      </button>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="title text-[1.35rem]">Raw feed</h1>
          <p className="mt-1 max-w-xl text-[0.98rem] text-mid">
            Individual routing updates and measurements as they arrive. A fair sample of at most 20
            a second; the counts and charts elsewhere use every event.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[0.84rem]">
          <span
            className="glass rounded-md px-2.5 py-1.5 text-hi"
            title="Events in this view per second, before sampling"
          >
            {formatInt(Math.round(perSecond))}/s
          </span>
          <span
            className="glass rounded-md px-2.5 py-1.5 text-mid"
            title="Share of this view's events shown as rows"
          >
            showing {share}%
          </span>
          {sampling && (
            <span
              className="rounded-md bg-caution/15 px-2.5 py-1.5 text-caution"
              title="The server is under load and thins the feed further"
            >
              sampling 1 in {queue.sampleEvery ?? '?'}
            </span>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div
          className="glass flex max-w-full overflow-x-auto rounded-md p-0.5"
          role="radiogroup"
          aria-label="Event type"
        >
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              onClick={() => setKind(k.kind)}
              className={`shrink-0 rounded px-2.5 py-1 text-[0.92rem] transition ${kind === k.kind ? 'bg-white/[0.09] text-hi' : 'text-mid hover:text-hi'}`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <select
          value={cc}
          onChange={(e) => setCc(e.target.value)}
          aria-label="Country"
          className="glass rounded-md px-2.5 py-1.5 text-[0.92rem] text-hi outline-none"
        >
          <option value="*">Everywhere</option>
          {codes.map((c) => (
            <option key={c} value={c}>
              {countryName(c)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            if (!frozen) return pause();
            setFrozen(null);
            setResumes((n) => n + 1);
          }}
          className="glass ml-auto rounded-md px-3 py-1.5 text-[0.92rem] text-hi"
        >
          {frozen ? `Resume${waiting > 0 ? ` (${formatInt(waiting)} new)` : ''}` : 'Pause'}
        </button>
      </div>

      <section className="glass mt-4 rounded-lg pt-3">
        {header}
        {rows.length === 0 ? (
          <p className="px-3 py-10 text-center text-[0.95rem] text-mid">
            Waiting for events{cc !== '*' ? ` from ${countryName(cc)}` : ''}…
          </p>
        ) : (
          <VirtualList
            key={resumes}
            items={rows}
            getKey={(e) => e.id}
            estimate={37}
            label="Raw events, newest first"
            className="h-[62vh]"
            // Scrolling down to read pauses the list, so rows do not move under the reader.
            onScroll={(e) => {
              if (e.currentTarget.scrollTop > 12 && !frozen) pause();
            }}
            renderRow={(e) => <Row e={e} />}
          />
        )}
      </section>
    </main>
  );
}
