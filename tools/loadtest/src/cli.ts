import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { RealtimeConfig } from '@ins/shared';
import {
  adminToken,
  busiestCountries,
  clockOffset,
  getJson,
  replay,
  startSampler,
  type ServerSample,
} from './server.ts';
import { startRelay } from './relay.ts';
import { runSwarm } from './swarm.ts';

const HELP = `Load tests for the Internet Nervous System server.

  pnpm loadtest run [options]       clients + optional replay + server sampling -> results/<name>.json
  pnpm loadtest replay start|stop|status [--speed 50 --amplify 1 --lossy]
  pnpm loadtest sample [--duration 60]   server numbers once a second, nothing else
  pnpm loadtest relay --port 3901 --target wss://ris-live.ripe.net
                                    a WebSocket relay to cut a server's upstream (chaos test):
                                    run the server with RIS_URL=ws://localhost:3901/v1/ws/?client=...

Options for run:
  --base URL          server (default http://localhost:3000)
  --clients N         Socket.IO clients (default 100)
  --rooms LIST        rooms per client, comma-separated (default world,incidents,arcs,country)
                      "country" gives each client one of the 10 busiest countries in turn
  --feed              one client in ten also watches the raw feed (feed:*:*)
  --ramp S            spread connections over S seconds (default 10)
  --duration S        measure for S seconds after the ramp (default 60)
  --speed X           also play the Facebook replay at X (1-50) during the run
  --amplify N         replay each event N times (load; default 1)
  --lossy             replay sheds like a live feed instead of waiting
  --loop              start the replay again whenever it finishes (long soak tests)
  --name NAME         results file name (default: a timestamp)

Auth: LOADTEST_TOKEN (an admin access token) or JWT_SECRET (the server's, for your own server).
The server must allow this many connections from one address: SOCKET_CONNECTIONS_PER_MIN.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    clients: { type: 'string', default: '100' },
    rooms: { type: 'string', default: 'world,incidents,arcs,country' },
    feed: { type: 'boolean', default: false },
    ramp: { type: 'string', default: '10' },
    duration: { type: 'string', default: '60' },
    speed: { type: 'string' },
    amplify: { type: 'string', default: '1' },
    lossy: { type: 'boolean', default: false },
    loop: { type: 'boolean', default: false },
    name: { type: 'string' },
    port: { type: 'string', default: '3901' },
    target: { type: 'string', default: 'wss://ris-live.ripe.net' },
    help: { type: 'boolean', default: false },
  },
});

const base = values.base.replace(/\/$/, '');
const log = (line: string) => process.stdout.write(`${line}\n`);

/** Mean and max of each numeric field over the samples. */
function summarise(samples: ServerSample[]) {
  const out: Record<string, { mean: number; max: number }> = {};
  if (samples.length === 0) return out;
  for (const key of Object.keys(samples[0]!) as (keyof ServerSample)[]) {
    if (key === 'at') continue;
    const vs = samples.map((s) => s[key]);
    out[key] = {
      mean: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 10) / 10,
      max: Math.max(...vs),
    };
  }
  return out;
}

async function run() {
  const clients = Number(values.clients);
  const rampMs = Number(values.ramp) * 1000;
  const measureMs = Number(values.duration) * 1000;
  const token = adminToken();
  const realtime = await getJson<RealtimeConfig>(base, '/api/realtime');
  const offsetMs = await clockOffset(base);
  const countries = await busiestCountries(base, 10);
  const roomList = values.rooms.split(',').map((r) => r.trim());
  const roomsFor = (i: number) => {
    const rooms = roomList.map((r) =>
      r === 'country' ? `country:${countries[i % countries.length]}` : r,
    );
    if (values.feed && i % 10 === 0) rooms.push('feed:*:*');
    return rooms;
  };

  log(
    `server ${base}: parser ${realtime.parser}, conflation ${realtime.conflateMs} ms, clock offset ${offsetMs} ms`,
  );
  const sampler = startSampler(base, token, (s) =>
    log(
      `  t=${s.at}s  in ${s.eventsPerSec}/s  queue ${Math.round(s.queueFill * 100)}%  cpu ${s.cpuPct}%  rss ${s.rssMb} MB  loop ${s.mainLoopP99Ms}/${s.ingestLoopP99Ms} ms  out ${Math.round(s.bytesOutPerSec / 1024)} KB/s  sockets ${s.liveSockets}`,
    ),
  );

  if (values.speed) {
    await replay(base, token, {
      action: 'start',
      scenario: 'facebook-2021',
      speed: Number(values.speed),
      amplify: Number(values.amplify),
      lossy: values.lossy,
    });
    log(
      `replay started at ${values.speed}x, amplify ${values.amplify}${values.lossy ? ', lossy' : ''}`,
    );
  }
  // A long soak outlasts the recording: start it again (fresh event IDs each run) when it ends.
  let restarts = 0;
  const startReplay = () =>
    replay(base, token, {
      action: 'start',
      scenario: 'facebook-2021',
      speed: Number(values.speed),
      amplify: Number(values.amplify),
      lossy: values.lossy,
    });
  const looper =
    values.speed && values.loop
      ? setInterval(() => {
          void getJson<{ state: string }>(base, '/api/admin/replay', token)
            .then(async (r) => {
              if (r.state !== 'finished') return;
              await startReplay();
              restarts += 1;
              log(`replay finished; started again (${restarts})`);
            })
            .catch(() => {});
        }, 5000)
      : null;

  log(
    `connecting ${clients} clients over ${values.ramp} s, then measuring for ${values.duration} s`,
  );
  const swarm = await runSwarm(
    { base, clients, roomsFor, rampMs, parser: realtime.parser, offsetMs },
    measureMs,
    (r) =>
      log(
        `  clients ${r.connected}/${r.clients}  frames/client/s ${r.framesPerClientPerSec}  delivery p50 ${r.deliveryMs.p50} p99 ${r.deliveryMs.p99} ms  gaps ${r.gaps}  disconnects ${r.disconnects}`,
      ),
  );

  if (looper) clearInterval(looper);
  if (values.speed) await replay(base, token, { action: 'stop' }).catch(() => {});
  sampler.stop();

  const result = {
    name: values.name ?? new Date().toISOString().replace(/[:.]/g, '-'),
    at: new Date().toISOString(),
    config: {
      base,
      clients,
      rooms: roomList,
      feed: values.feed,
      rampS: Number(values.ramp),
      durationS: Number(values.duration),
      replay: values.speed
        ? {
            speed: Number(values.speed),
            amplify: Number(values.amplify),
            lossy: values.lossy,
            loop: values.loop,
            restarts,
          }
        : null,
      server: realtime,
    },
    swarm,
    server: summarise(sampler.samples),
    timeline: sampler.samples,
  };
  const dir = join(import.meta.dirname, '..', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${result.name}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));

  log('');
  log(
    `clients connected      ${swarm.connected}/${clients} (${swarm.connectErrors} connect errors, ${swarm.disconnects} disconnects)`,
  );
  log(`frames per client/s    ${swarm.framesPerClientPerSec}`);
  log(`bytes per client/s     ${swarm.bytesPerClientPerSec}`);
  log(
    `delivery ms            p50 ${swarm.deliveryMs.p50}  p95 ${swarm.deliveryMs.p95}  p99 ${swarm.deliveryMs.p99}  max ${swarm.deliveryMs.max}`,
  );
  log(`sequence               ${swarm.gaps} gaps, ${swarm.duplicates} duplicates`);
  const s = result.server;
  if (s.cpuPct) log(`server cpu %            mean ${s.cpuPct.mean}  max ${s.cpuPct.max}`);
  if (s.rssMb) log(`server rss MB           mean ${s.rssMb.mean}  max ${s.rssMb.max}`);
  if (s.eventsPerSec)
    log(`events in /s           mean ${s.eventsPerSec.mean}  max ${s.eventsPerSec.max}`);
  log(`results                ${file}`);
}

async function main() {
  const [command, sub] = positionals;
  if (values.help || !command) return log(HELP);
  if (command === 'run') return run();
  if (command === 'replay') {
    const token = adminToken();
    const body =
      sub === 'start'
        ? {
            action: 'start',
            scenario: 'facebook-2021',
            speed: Number(values.speed ?? 10),
            amplify: Number(values.amplify),
            lossy: values.lossy,
          }
        : { action: sub ?? 'status' };
    if (sub === 'status')
      return log(JSON.stringify(await getJson(base, '/api/admin/replay', token)));
    return log(JSON.stringify(await replay(base, token, body)));
  }
  if (command === 'relay') {
    startRelay(Number(values.port), values.target, log);
    log(`relay listening on :${values.port} -> ${values.target} (Ctrl-C cuts it)`);
    return new Promise<void>(() => {}); // until killed
  }
  if (command === 'sample') {
    const sampler = startSampler(base, adminToken(), (s) => log(JSON.stringify(s)));
    await new Promise((r) => setTimeout(r, Number(values.duration) * 1000));
    sampler.stop();
    return;
  }
  log(HELP);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
