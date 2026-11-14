import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { RefData } from '../refdata/index.ts';
import type { ProbeInfo } from '../refdata/probes.ts';
import { FEED_EVERY_MS, FeedSampler } from './feed.ts';
import { startIngest } from './index.ts';
import type { Lookup } from './pipeline/pipeline.ts';
import type { Call, FromIngest, IngestState, Port, ToIngest } from './protocol.ts';

/** Network and probe locations; probes are needed for the dropout detector. */
export type IngestLookup = Lookup & { allProbes?(): Iterable<ProbeInfo> };

const STATE_EVERY_MS = 250;

/**
 * The ingest side of the link: upstream feeds -> pipeline -> detectors.
 *
 * Runs in the ingest worker thread (see worker.ts), or in the main thread
 * over a MessageChannel when `INGEST_THREAD=off` (tests). Either way it only
 * talks through `port`, so both modes behave the same.
 *
 * It never touches MongoDB or Socket.IO: it sends closed windows, incidents
 * and a state summary, and the main thread stores and broadcasts them.
 */
export function serveIngest(
  port: Port,
  opts: { config: Config; log: Logger; lookup?: IngestLookup },
): () => void {
  const { config, log } = opts;
  const send = (message: FromIngest) => port.postMessage(message);

  // Reference data arrives from the main thread (which loads it from MongoDB).
  const refdata = new RefData();
  const lookup: IngestLookup = opts.lookup ?? refdata;

  // Network names for incident text: asked of the main thread once, then kept.
  const names = new Map<number, string>();
  const asked = new Set<number>();
  const nameOf = (asn: number) => {
    const known = names.get(asn);
    if (known) return known;
    if (!asked.has(asn)) {
      asked.add(asn);
      send({ t: 'needName', asn });
    }
    return null;
  };

  // Connected Atlas probes per country, recounted once a minute (dropout detector).
  let probeCounts = new Map<string, number>();
  let countedAt = 0;
  const connectedProbes = (cc: string) => {
    if (Date.now() - countedAt > 60_000) {
      countedAt = Date.now();
      probeCounts = new Map();
      for (const p of lookup.allProbes?.() ?? []) {
        if (p.cc && p.status === 'Connected')
          probeCounts.set(p.cc, (probeCounts.get(p.cc) ?? 0) + 1);
      }
    }
    return probeCounts.get(cc) ?? 0;
  };

  let masked: Set<number> | null = null;
  const ingest = startIngest(config, log, lookup, {
    nameOf,
    connectedProbes,
    // While a scenario simulates a network, live updates for it stay out of detection.
    isMasked: (asn) => masked?.has(asn) ?? false,
  });

  // Firehose: a fair sample of raw events for the feed rooms people are watching.
  const feed = new FeedSampler();
  ingest.onEvent((event, ctx) => {
    if (feed.active) feed.offer(event, ctx, () => ingest.queue.sample());
  });
  const feedTimer = setInterval(() => {
    const batches = feed.take();
    if (batches.length > 0) send({ t: 'feed', batches });
  }, FEED_EVERY_MS);

  ingest.onSecond((window) => send({ t: 'second', window }));
  ingest.onMinute((window) => send({ t: 'minute', window }));
  // The manager keeps changing the same object; the message is a copy of this moment.
  ingest.onIncident((incident) => send({ t: 'incident', incident }));

  // This thread's own event-loop delay: how late its timers run under load.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let states = 0;

  const state = (): IngestState => {
    const { pipeline } = ingest;
    const probes: IngestState['probes'] = [];
    for (const id of pipeline.probesChanged) {
      const p = pipeline.probeLatest.get(id);
      if (p) probes.push([id, p.ts, p.rtt]);
    }
    pipeline.probesChanged.clear();
    const mem = process.memoryUsage();
    const loopDelayMs = Math.round(loop.percentile(99) / 1e4) / 100;
    // A fresh p99 each second.
    if (++states % (1000 / STATE_EVERY_MS) === 0) loop.reset();
    return {
      sources: Object.fromEntries(ingest.stats.sources().map((s) => [s, ingest.stats.of(s)])),
      connections: ingest.connections(),
      latest: ingest.latest,
      pipeline: pipeline.snapshot(),
      replay: ingest.replay.snapshot(),
      queue: ingest.queue.snapshot(),
      feedSampledOut: feed.sampledOut,
      probes,
      thread: {
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        loopDelayMs,
      },
    };
  };
  const stateTimer = setInterval(() => send({ t: 'state', state: state() }), STATE_EVERY_MS);

  function answer(call: Call): unknown {
    switch (call.op) {
      case 'replay': {
        const r = ingest.replay;
        if (call.action === 'start')
          r.start(call.scenario, call.speed, call.from, call.lossy, call.amplify);
        else if (call.action === 'pause') r.pause();
        else if (call.action === 'resume') r.resume();
        else if (call.action === 'stop') r.stop();
        else if (call.action === 'speed') r.setSpeed(call.speed);
        return r.snapshot();
      }
      case 'prefixesOf':
        return ingest.pipeline.origins.prefixesOf(call.asn, call.limit);
      case 'largestIn':
        return ingest.pipeline.origins.largest(call.n, (asn) => lookup.asnCountry(asn) === call.cc);
      case 'stop':
        stop();
        return true;
    }
  }

  port.on('message', (message: ToIngest) => {
    switch (message.t) {
      case 'events':
        ingest.stats.accepted(message.source, message.batch.length, message.now, message.now);
        ingest.queue.offer(message.batch);
        break;
      case 'masked':
        masked = message.asns ? new Set(message.asns) : null;
        break;
      case 'refdata':
        if (message.ranges) refdata.setAsnRanges(message.ranges);
        if (message.probes) refdata.setProbes(message.probes);
        countedAt = 0; // recount probes with the new list
        break;
      case 'warmStart':
        ingest.detectors.warmStart(message.covered, message.wd);
        break;
      case 'radar':
        ingest.detectors.observeRadar(message.events);
        break;
      case 'feedRooms':
        feed.watch(message.rooms);
        break;
      case 'name':
        names.set(message.asn, message.name);
        break;
      case 'call':
        try {
          send({ t: 'reply', id: message.id, ok: true, value: answer(message.call) });
        } catch (err) {
          send({ t: 'reply', id: message.id, ok: false, error: String(err) });
        }
        break;
    }
  });

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(stateTimer);
    clearInterval(feedTimer);
    loop.disable();
    ingest.stop();
  }

  send({ t: 'ready' });
  // The first state at once, so the main thread never reads an empty one for long.
  send({ t: 'state', state: state() });
  return stop;
}
