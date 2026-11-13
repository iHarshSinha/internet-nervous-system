import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Recorder } from './recorder.ts';
import { buildStreams } from './streams.ts';

/*
 * ins-capture: connect to the real feeds, validate and count everything, and
 * (optionally) record it for replay and stress tests.
 *
 *   pnpm capture --minutes 10 --no-record   (from the repository root)
 *   pnpm capture --minutes 30
 */

const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '10' },
    out: { type: 'string', default: '../../deploy/seed/capture' },
    'no-record': { type: 'boolean', default: false },
    client: { type: 'string', default: process.env.RIS_CLIENT_NAME ?? 'internet-nervous-system' },
    'ris-host': { type: 'string', default: 'rrc00' },
    msm: { type: 'string', default: '1001,1008,1006' },
    'report-seconds': { type: 'string', default: '10' },
  },
});

const minutes = Number(values.minutes);
const reportSeconds = Number(values['report-seconds']);
const atlasMsms = values.msm.split(',').map(Number);
if (!(minutes > 0) || !(reportSeconds > 0) || atlasMsms.some((n) => !Number.isInteger(n))) {
  process.stderr.write('Invalid arguments. Example: --minutes 10 --msm 1001,1008,1006\n');
  process.exit(2);
}

const record = !values['no-record'];
const outDir = resolve(values.out);
if (record) mkdirSync(outDir, { recursive: true });

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'; // 20261113T081500Z
const print = (line: string) => process.stdout.write(line + '\n');

const recorders = buildStreams({
  client: values.client,
  risHost: values['ris-host'],
  atlasMsms,
  record,
}).map((spec) => new Recorder(spec, outDir, stamp, print));

// Process health while capturing: memory, CPU, and how long the event loop stalls.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const cpuStart = process.cpuUsage();
let peakRssMb = 0;
let peakHeapMb = 0;
const mb = (bytes: number) => bytes / 1024 / 1024;
const fmt = (n: number | null, digits = 0) => (n === null ? '-' : n.toFixed(digits));

print(`ins-capture: ${minutes} min, recording ${record ? `to ${outDir}` : 'off'}`);
for (const r of recorders) print(`  ${r.spec.name.padEnd(13)} ${r.spec.subscription}`);
print('');
for (const r of recorders) r.start();

let lastReport = Date.now();
const reportTimer = setInterval(() => {
  const now = Date.now();
  const seconds = (now - lastReport) / 1000;
  lastReport = now;

  const mem = process.memoryUsage();
  peakRssMb = Math.max(peakRssMb, mb(mem.rss));
  peakHeapMb = Math.max(peakHeapMb, mb(mem.heapUsed));

  const elapsed = Math.round((now - startedAt.getTime()) / 1000);
  print(
    `t+${String(elapsed).padStart(4)}s  rss ${fmt(mb(mem.rss))} MB  heap ${fmt(mb(mem.heapUsed))} MB`,
  );
  for (const r of recorders) {
    const rate = r.stats.endInterval(seconds);
    print(
      `  ${r.spec.name.padEnd(13)} ${fmt(rate.messagesPerSec, 1).padStart(8)} msg/s` +
        ` ${fmt(rate.eventsPerSec, 1).padStart(9)} events/s ${fmt(rate.kbPerSec, 1).padStart(8)} KB/s` +
        `  lag p50 ${fmt(r.stats.lag.percentile(0.5))} ms  invalid ${r.stats.invalid}`,
    );
  }
}, reportSeconds * 1000);

let finishing = false;
async function finish(): Promise<void> {
  if (finishing) return;
  finishing = true;
  clearInterval(reportTimer);
  clearTimeout(endTimer);
  await Promise.all(recorders.map((r) => r.stop()));

  const durationSec = (Date.now() - startedAt.getTime()) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

  const summary = {
    startedAt: startedAt.toISOString(),
    durationSec: round(durationSec),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    process: {
      peakRssMb: round(peakRssMb),
      peakHeapMb: round(peakHeapMb),
      // 100 means one CPU core fully busy for the whole run.
      avgCpuPercent: round(((cpu.user + cpu.system) / 1e6 / durationSec) * 100),
      eventLoopDelayMs: {
        p50: round(loopDelay.percentile(50) / 1e6, 2),
        p99: round(loopDelay.percentile(99) / 1e6, 2),
        max: round(loopDelay.max / 1e6, 2),
      },
    },
    streams: recorders.map((r) => {
      const s = r.stats;
      return {
        name: r.spec.name,
        subscription: r.spec.subscription,
        messages: s.messages,
        events: s.events,
        avgMessagesPerSec: round(s.messages / durationSec),
        avgEventsPerSec: round(s.events / durationSec),
        peakMessagesPerSec: round(s.peakMessagesPerSec),
        peakEventsPerSec: round(s.peakEventsPerSec),
        avgKbPerSec: round(s.bytes / durationSec / 1024),
        maxMessageBytes: s.maxMessageBytes,
        byType: s.byType,
        // Busiest first.
        byCollector: Object.fromEntries(Object.entries(s.byCollector).sort((a, b) => b[1] - a[1])),
        lagMs: {
          p50: s.lag.percentile(0.5),
          p95: s.lag.percentile(0.95),
          p99: s.lag.percentile(0.99),
          max: Math.round(s.lag.max),
        },
        outOfOrder: {
          count: s.outOfOrder,
          percent: s.messages === 0 ? 0 : round((s.outOfOrder / s.messages) * 100, 2),
          latenessMs: {
            p50: s.lateness.percentile(0.5),
            p95: s.lateness.percentile(0.95),
            p99: s.lateness.percentile(0.99),
            max: Math.round(s.lateness.max),
          },
        },
        futureTimestamps: s.futureTimestamps,
        control: s.control,
        invalid: s.invalid,
        unparseable: s.unparseable,
        upstreamWarnings: s.warnings,
        reconnects: s.reconnects,
        invalidSamples: s.invalidSamples,
        warningSamples: s.warningSamples,
        file: r.filePath,
        fileMb: r.filePath ? round(mb(statSync(r.filePath).size), 2) : null,
      };
    }),
  };

  print('\n' + JSON.stringify(summary, null, 2));
  if (record) {
    const path = `${outDir}/summary-${stamp}.json`;
    writeFileSync(path, JSON.stringify(summary, null, 2) + '\n');
    print(`\nsummary written to ${path}`);
  }
  process.exit(0);
}

const endTimer = setTimeout(() => void finish(), minutes * 60_000);
process.on('SIGINT', () => void finish());
process.on('SIGTERM', () => void finish());
