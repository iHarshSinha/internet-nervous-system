import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createGzip, gunzipSync } from 'node:zlib';
import { eventEnvelopeSchema, makeEid, type EventEnvelope } from '@ins/shared';
import { emptyStats, parseMrt } from './mrt.ts';

/*
 * ins-replay-prep: download archived RIS update files for a time window,
 * convert them to our event envelope and write one time-ordered, gzipped
 * NDJSON file that the replay source can stream through the pipeline.
 *
 * Default window: the Facebook outage, 4 Oct 2021, 15:20-16:30 UTC.
 *
 *   pnpm replay-prep                  (from the repository root)
 *   pnpm replay-prep --collectors rrc00,rrc10 --from 1530 --to 1600
 *
 * Source: RIPE NCC RIS raw data, https://data.ris.ripe.net/
 */

const { values } = parseArgs({
  options: {
    collectors: { type: 'string', default: 'rrc05,rrc10,rrc11,rrc14' },
    date: { type: 'string', default: '20211004' },
    from: { type: 'string', default: '1520' },
    to: { type: 'string', default: '1630' },
    out: { type: 'string', default: '../../deploy/seed/replay' },
    name: { type: 'string', default: 'facebook-20211004' },
    /** Network to report on while converting, to check the incident is in the data. */
    'watch-asn': { type: 'string', default: '32934' },
  },
});

const collectors = values.collectors.split(',').map((c) => c.trim());
const watchAsn = Number(values['watch-asn']);
const outDir = resolve(values.out);
const cacheDir = `${outDir}/mrt`;
const print = (line: string) => process.stdout.write(line + '\n');

if (!/^\d{8}$/.test(values.date) || !/^\d{4}$/.test(values.from) || !/^\d{4}$/.test(values.to)) {
  process.stderr.write('Expected --date YYYYMMDD --from HHmm --to HHmm\n');
  process.exit(2);
}

/** RIS writes one file every 5 minutes, named by the start of the interval. */
function slots(from: string, to: string): string[] {
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
  const out: string[] = [];
  for (let m = minutes(from); m < minutes(to); m += 5) {
    out.push(String(Math.floor(m / 60)).padStart(2, '0') + String(m % 60).padStart(2, '0'));
  }
  return out;
}

async function download(collector: string, hhmm: string): Promise<Buffer> {
  const file = `updates.${values.date}.${hhmm}.gz`;
  const cached = `${cacheDir}/${collector}/${file}`;
  if (existsSync(cached)) return readFileSync(cached);

  const month = `${values.date.slice(0, 4)}.${values.date.slice(4, 6)}`;
  const url = `https://data.ris.ripe.net/${collector}/${month}/${file}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      mkdirSync(`${cacheDir}/${collector}`, { recursive: true });
      writeFileSync(cached, body);
      return body;
    } catch (err) {
      if (attempt === 3) throw new Error(`Could not download ${url}`, { cause: err });
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

mkdirSync(outDir, { recursive: true });
const outPath = `${outDir}/${values.name}.ndjson.gz`;
const gzip = createGzip({ level: 6 });
const file = createWriteStream(outPath);
gzip.pipe(file);

const totals = { announce: 0, withdraw: 0, peerState: 0 };
const mrt = emptyStats();
const perCollector: Record<string, number> = {};

// For the check at the end: remember who originates each prefix (learned from
// announcements), so a withdrawal can be attributed to a network.
const originOf = new Map<string, number>();
interface Minute {
  announce: number;
  withdraw: number;
  watchAnnounce: number;
  watchWithdraw: number;
  watchPrefixes: Set<string>;
}
const perMinute = new Map<number, Minute>();
const minuteOf = (tsMs: number): Minute => {
  const key = Math.floor(tsMs / 60_000);
  let m = perMinute.get(key);
  if (!m) {
    m = { announce: 0, withdraw: 0, watchAnnounce: 0, watchWithdraw: 0, watchPrefixes: new Set() };
    perMinute.set(key, m);
  }
  return m;
};

let firstTs = Infinity;
let lastTs = 0;

for (const hhmm of slots(values.from, values.to)) {
  const events: EventEnvelope[] = [];

  for (const collector of collectors) {
    const raw = gunzipSync(await download(collector, hhmm));
    let index = 0;
    for (const rec of parseMrt(raw, mrt)) {
      // Deterministic IDs: converting the same files again gives the same
      // events, so replaying twice can never create duplicates.
      const id = `${collector}-${values.date}${hhmm}-${index++}`;
      const base = { v: 1 as const, src: 'replay' as const, ts: rec.tsMs, its: rec.tsMs };

      if (rec.kind === 'state') {
        events.push({
          ...base,
          eid: makeEid('replay', id),
          kind: 'bgp.peer_state',
          entity: { collector },
          data: { peerAsn: rec.peerAsn, peer: rec.peerIp, from: rec.oldState, to: rec.newState },
        });
        continue;
      }

      // One event per prefix, numbered #0, #1, ... as the envelope contract says.
      let part = 0;
      for (const prefix of rec.withdrawn) {
        events.push({
          ...base,
          eid: makeEid('replay', id, part++),
          kind: 'bgp.withdraw',
          entity: { prefix, collector },
          data: { peerAsn: rec.peerAsn, peer: rec.peerIp },
        });
      }
      for (const prefix of rec.announced) {
        events.push({
          ...base,
          eid: makeEid('replay', id, part++),
          kind: 'bgp.announce',
          entity: { prefix, collector, ...(rec.originAsn !== null && { asn: rec.originAsn }) },
          data: { peerAsn: rec.peerAsn, peer: rec.peerIp, pathLen: rec.pathLen },
        });
      }
    }
    perCollector[collector] = (perCollector[collector] ?? 0) + index;
  }

  // Files of one slot cover the same 5 minutes, so sorting slot by slot gives
  // a globally time-ordered output without holding everything in memory.
  events.sort((a, b) => a.ts - b.ts);

  for (const event of events) {
    const checked = eventEnvelopeSchema.safeParse(event);
    if (!checked.success) {
      throw new Error(
        `Produced an invalid event: ${JSON.stringify(event)} ${checked.error.message}`,
      );
    }

    firstTs = Math.min(firstTs, event.ts);
    lastTs = Math.max(lastTs, event.ts);
    const minute = minuteOf(event.ts);
    const prefix = event.entity.prefix;
    if (event.kind === 'bgp.announce' && prefix) {
      totals.announce += 1;
      minute.announce += 1;
      if (event.entity.asn !== undefined) originOf.set(prefix, event.entity.asn);
      if (event.entity.asn === watchAsn) minute.watchAnnounce += 1;
    } else if (event.kind === 'bgp.withdraw' && prefix) {
      totals.withdraw += 1;
      minute.withdraw += 1;
      if (originOf.get(prefix) === watchAsn) {
        minute.watchWithdraw += 1;
        minute.watchPrefixes.add(prefix);
      }
    } else {
      totals.peerState += 1;
    }

    // Respect backpressure: wait when gzip's buffer is full.
    if (!gzip.write(JSON.stringify(event) + '\n')) await once(gzip, 'drain');
  }
  print(`${values.date} ${hhmm}  ${String(events.length).padStart(8)} events`);
}

gzip.end();
await once(file, 'close');

// ---- report

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const minutes = [...perMinute.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([key, m]) => ({
    minute: new Date(key * 60_000).toISOString().slice(11, 16),
    announce: m.announce,
    withdraw: m.withdraw,
    watchAnnounce: m.watchAnnounce,
    watchWithdraw: m.watchWithdraw,
    watchPrefixesWithdrawn: m.watchPrefixes.size,
  }));

// The same rule detector D1 starts from: at least 20 distinct prefixes withdrawn in a minute.
const firstStorm = minutes.find((m) => m.watchPrefixesWithdrawn >= 20);
const watchPrefixesSeen = [...originOf.values()].filter((asn) => asn === watchAsn).length;

const summary = {
  name: values.name,
  source: 'RIPE NCC RIS raw data (https://data.ris.ripe.net/), MRT update files',
  collectors,
  window: `${values.date} ${values.from}-${values.to} UTC`,
  firstEvent: hhmmss(firstTs),
  lastEvent: hhmmss(lastTs),
  events: totals.announce + totals.withdraw + totals.peerState,
  ...totals,
  mrt,
  mrtRecordsPerCollector: perCollector,
  watch: {
    asn: watchAsn,
    prefixesSeenAnnounced: watchPrefixesSeen,
    firstMinuteWith20PrefixesWithdrawn: firstStorm?.minute ?? null,
  },
  perMinute: minutes,
};
const summaryPath = `${outDir}/${values.name}.summary.json`;
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');

print('');
print(
  `events: ${summary.events} (announce ${totals.announce}, withdraw ${totals.withdraw}, peer state ${totals.peerState})`,
);
print(`MRT records: ${mrt.records}, malformed ${mrt.malformed}, skipped ${mrt.skipped}`);
print(
  `AS${watchAsn}: ${watchPrefixesSeen} prefixes seen; first minute with >=20 withdrawn: ${firstStorm?.minute ?? 'none'}`,
);
print('');
print('minute  announce  withdraw | AS' + watchAsn + ' announce  withdraw  prefixes withdrawn');
for (const m of minutes) {
  if (m.watchWithdraw === 0 && m.watchAnnounce === 0) continue;
  print(
    `${m.minute}   ${String(m.announce).padStart(8)}  ${String(m.withdraw).padStart(8)} |` +
      ` ${String(m.watchAnnounce).padStart(14)}  ${String(m.watchWithdraw).padStart(8)}  ${String(m.watchPrefixesWithdrawn).padStart(8)}`,
  );
}
print(`\nwrote ${outPath}\nwrote ${summaryPath}`);
