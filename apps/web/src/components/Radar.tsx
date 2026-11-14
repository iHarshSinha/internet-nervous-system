import type { RadarEvent, RadarType } from '@ins/shared';
import { memo, useState } from 'react';
import { countryName } from '../geo.ts';
import { useTick } from '../hooks/tick.ts';
import { useRadar } from '../store/radar.ts';
import { flag } from '../theme.ts';
import { ago } from './Incidents.tsx';
import { Panel } from './ui.tsx';

const TYPE_LABEL: Record<RadarType, string> = {
  outage: 'Outage',
  anomaly: 'Traffic drop',
  hijack: 'Hijack',
  leak: 'Route leak',
};
const TYPE_COLOR: Record<RadarType, string> = {
  outage: '#ff4d5e',
  anomaly: '#ffb454',
  hijack: '#d78cff',
  leak: '#9b8cff',
};

/** Outages and anomalies first (people care most), then the newest. */
function order(events: RadarEvent[]): RadarEvent[] {
  const rank = { outage: 0, anomaly: 1, hijack: 2, leak: 3 } as const;
  return events.sort(
    (a, b) =>
      Number(b.end === null) - Number(a.end === null) ||
      rank[a.type] - rank[b.type] ||
      b.start - a.start,
  );
}

/**
 * What Cloudflare sees from its own network: the busiest attack corridors and
 * its outage, anomaly, hijack and leak reports. Hidden when the server has no
 * Cloudflare token.
 */
export const RadarPanel = memo(function RadarPanel() {
  const enabled = useRadar((s) => s.enabled);
  const events = useRadar((s) => s.events);
  const pairs = useRadar((s) => s.pairs);
  const [tab, setTab] = useState<'attacks' | 'events'>('attacks');
  useTick(30_000);
  if (!enabled) return null;

  const corridors = pairs.filter((p) => p.layer === 'l7').slice(0, 6);
  const max = Math.max(1, ...corridors.map((p) => p.value));
  const list = order(Object.values(events)).slice(0, 6);

  return (
    <Panel
      title="Cloudflare Radar"
      collapsible
      defaultOpen={false}
      id="radar"
      aside={<span className="text-[0.86rem] text-low">last 24 h</span>}
      summary={
        <span className="text-[0.86rem] text-low">
          {corridors[0]
            ? `${flag(corridors[0].from)} → ${flag(corridors[0].to)} ${corridors[0].value.toFixed(1)}%`
            : '—'}
        </span>
      }
    >
      {/* A segmented switch between the two views. */}
      <div className="mb-3 grid grid-cols-2 rounded-md bg-white/[0.04] p-0.5 text-[0.9rem]">
        {(['attacks', 'events'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-[5px] py-1 transition ${tab === t ? 'bg-raised text-hi' : 'text-low hover:text-hi'}`}
          >
            {t === 'attacks' ? 'Attack corridors' : 'Reports'}
          </button>
        ))}
      </div>
      {tab === 'attacks' ? (
        <>
          <ul className="space-y-1.5">
            {corridors.map((p) => (
              <li
                key={`${p.from}-${p.to}`}
                className="relative overflow-hidden rounded-lg px-2 py-1"
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-lg bg-critical/[0.12]"
                  style={{ width: `${(p.value / max) * 100}%` }}
                />
                <span className="relative flex items-center gap-2 text-[0.84rem]">
                  <span title={countryName(p.from)}>{flag(p.from)}</span>
                  <span className="text-low">→</span>
                  <span title={countryName(p.to)}>{flag(p.to)}</span>
                  <span className="min-w-0 flex-1 truncate text-mid">
                    {p.from === p.to ? `within ${countryName(p.to)}` : `${p.from} to ${p.to}`}
                  </span>
                  <span className="font-mono text-hi tabular-nums">{p.value.toFixed(1)}%</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[0.74rem] text-low">
            Share of layer 7 attack traffic by origin and target, last 24 h. Arcs on the globe.
          </p>
        </>
      ) : (
        <ul className="space-y-1.5">
          {list.map((e) => (
            <li key={e.id}>
              <a
                href={e.url}
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg px-2 py-1.5 transition hover:bg-white/[0.05]"
              >
                <div className="flex items-center gap-2 text-[0.74rem]">
                  <span
                    className="font-mono font-semibold tracking-[0.1em] uppercase"
                    style={{ color: TYPE_COLOR[e.type] }}
                  >
                    {TYPE_LABEL[e.type]}
                  </span>
                  {e.countries.slice(0, 3).map((c) => (
                    <span key={c}>{flag(c)}</span>
                  ))}
                  <span className="ml-auto text-low">
                    {e.end === null ? 'ongoing' : ago(Date.now() - e.end)}
                  </span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[0.82rem] leading-snug text-mid">
                  {e.title}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[0.72rem] text-low">Data: Cloudflare Radar, CC BY-NC 4.0</p>
    </Panel>
  );
});
