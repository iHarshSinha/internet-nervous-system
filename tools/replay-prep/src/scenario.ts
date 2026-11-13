import { once } from 'node:events';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip, createGzip } from 'node:zlib';
import type { EventEnvelope } from '@ins/shared';

/*
 * Cut one network's outage out of a full replay file, as a small scenario the
 * server can inject into the live stream on demand (the "trigger outage"
 * button). Default: Facebook (AS32934), 4 Oct 2021.
 *
 *   pnpm --filter @ins/replay-prep scenario
 *
 * The output has two parts, both real recorded events:
 *   prime   the last announcement of each of the network's prefixes before
 *           the outage, so the pipeline knows they belong to it;
 *   outage  every announcement of, and withdrawal of, those prefixes in the
 *           outage window.
 * Each line is an event envelope with `data.part` set to "prime" or "outage".
 */

const { values } = parseArgs({
  options: {
    in: { type: 'string', default: '../../deploy/seed/replay/facebook-20211004.ndjson.gz' },
    out: { type: 'string', default: '../../deploy/seed/scenarios/facebook-2021.ndjson.gz' },
    asn: { type: 'string', default: '32934' },
    from: { type: 'string', default: '2021-10-04T15:39:00Z' },
    to: { type: 'string', default: '2021-10-04T15:54:00Z' },
  },
});

const asn = Number(values.asn);
const from = Date.parse(values.from);
const to = Date.parse(values.to);
const print = (line: string) => process.stdout.write(line + '\n');

const owned = new Set<string>(); // prefixes this network announced
const prime = new Map<string, EventEnvelope>(); // last announcement per prefix before `from`
const outage: EventEnvelope[] = [];

const lines = createInterface({ input: createReadStream(resolve(values.in)).pipe(createGunzip()) });
for await (const line of lines) {
  const e = JSON.parse(line) as EventEnvelope;
  if (e.ts >= to) break; // the file is sorted by time
  const prefix = e.entity.prefix;
  if (!prefix) continue;
  const mine = e.kind === 'bgp.announce' ? e.entity.asn === asn : owned.has(prefix);
  if (!mine) continue;
  if (e.kind === 'bgp.announce') owned.add(prefix);
  if (e.ts < from) {
    if (e.kind === 'bgp.announce') prime.set(prefix, e);
  } else {
    outage.push(e);
  }
}

const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
const gzip = createGzip({ level: 9 });
const file = createWriteStream(out);
gzip.pipe(file);
for (const e of prime.values())
  gzip.write(JSON.stringify({ ...e, data: { ...e.data, part: 'prime' } }) + '\n');
for (const e of outage)
  gzip.write(JSON.stringify({ ...e, data: { ...e.data, part: 'outage' } }) + '\n');
gzip.end();
await once(file, 'close');

const withdrawals = outage.filter((e) => e.kind === 'bgp.withdraw').length;
print(`AS${asn}: ${owned.size} prefixes, ${prime.size} primed`);
print(
  `outage window ${values.from} - ${values.to}: ${outage.length} events (${withdrawals} withdrawals)`,
);
print(`wrote ${out}`);
