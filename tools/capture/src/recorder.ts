import { createWriteStream, type WriteStream } from 'node:fs';
import { createGzip, type Gzip } from 'node:zlib';
import WebSocket from 'ws';
import { LogHistogram } from './histogram.ts';
import type { StreamSpec } from './streams.ts';

/** Counters for one stream. `interval*` fields are reset after every report. */
export class StreamStats {
  messages = 0;
  events = 0;
  bytes = 0;
  control = 0;
  invalid = 0;
  unparseable = 0;
  warnings = 0;
  reconnects = 0;
  maxMessageBytes = 0;
  /** Messages whose event time is earlier than one we had already seen. */
  outOfOrder = 0;
  readonly byType: Record<string, number> = {};
  /** RIS only: messages per route collector. */
  readonly byCollector: Record<string, number> = {};
  /** Receive time minus event time: how old a message is when it reaches us. */
  readonly lag = new LogHistogram();
  /** For out-of-order messages: how far behind the newest event time they were. */
  readonly lateness = new LogHistogram();
  readonly invalidSamples: string[] = [];
  readonly warningSamples: string[] = [];

  intervalMessages = 0;
  intervalEvents = 0;
  intervalBytes = 0;
  /** Highest per-second rates seen in any reporting interval. */
  peakMessagesPerSec = 0;
  peakEventsPerSec = 0;

  private newestTs = 0;

  onData(
    type: string,
    events: number,
    tsMs: number,
    bytes: number,
    now: number,
    collector?: string,
  ): void {
    this.messages += 1;
    this.events += events;
    this.bytes += bytes;
    this.intervalMessages += 1;
    this.intervalEvents += events;
    this.intervalBytes += bytes;
    this.byType[type] = (this.byType[type] ?? 0) + 1;
    if (collector) this.byCollector[collector] = (this.byCollector[collector] ?? 0) + 1;
    if (bytes > this.maxMessageBytes) this.maxMessageBytes = bytes;

    this.lag.add(now - tsMs);
    if (tsMs < this.newestTs) {
      this.outOfOrder += 1;
      this.lateness.add(this.newestTs - tsMs);
    } else {
      this.newestTs = tsMs;
    }
  }

  /** Close the current reporting interval and return its per-second rates. */
  endInterval(seconds: number): { messagesPerSec: number; eventsPerSec: number; kbPerSec: number } {
    const rates = {
      messagesPerSec: this.intervalMessages / seconds,
      eventsPerSec: this.intervalEvents / seconds,
      kbPerSec: this.intervalBytes / seconds / 1024,
    };
    this.peakMessagesPerSec = Math.max(this.peakMessagesPerSec, rates.messagesPerSec);
    this.peakEventsPerSec = Math.max(this.peakEventsPerSec, rates.eventsPerSec);
    this.intervalMessages = this.intervalEvents = this.intervalBytes = 0;
    return rates;
  }
}

/**
 * One upstream connection: connects, subscribes, validates and counts every
 * message, optionally writes it to a gzipped NDJSON file, and reconnects with
 * exponential backoff if the connection drops.
 */
export class Recorder {
  readonly stats = new StreamStats();
  readonly filePath: string | null;

  private ws: WebSocket | null = null;
  private gzip: Gzip | null = null;
  private file: WriteStream | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  readonly spec: StreamSpec;
  private readonly log: (line: string) => void;

  constructor(spec: StreamSpec, outDir: string, stamp: string, log: (line: string) => void) {
    this.spec = spec;
    this.log = log;
    this.filePath = spec.record ? `${outDir}/${spec.name}-${stamp}.ndjson.gz` : null;
    if (this.filePath) {
      this.gzip = createGzip();
      this.file = createWriteStream(this.filePath);
      this.gzip.pipe(this.file);
    }
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.spec.url, { perMessageDeflate: false });
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.spec.subscribe(ws);
    });

    ws.on('message', (raw: Buffer) => {
      const now = Date.now();
      const text = raw.toString('utf8');
      const seen = this.spec.inspect(text);
      const s = this.stats;

      switch (seen.kind) {
        case 'data':
          s.onData(seen.type, seen.events, seen.tsMs, raw.length, now, seen.collector);
          // One line per message: our receive time plus the message exactly as it arrived.
          this.gzip?.write(`{"its":${now},"m":${text}}\n`);
          break;
        case 'control':
          s.control += 1;
          break;
        case 'warning':
          s.warnings += 1;
          if (s.warningSamples.length < 5) s.warningSamples.push(seen.text);
          this.log(`[${this.spec.name}] upstream warning: ${seen.text}`);
          break;
        case 'invalid':
          s.invalid += 1;
          if (s.invalidSamples.length < 5) {
            s.invalidSamples.push(`${seen.reason} :: ${text.slice(0, 300)}`);
          }
          break;
        case 'unparseable':
          s.unparseable += 1;
          break;
      }
    });

    ws.on('error', (err) => this.log(`[${this.spec.name}] socket error: ${err.message}`));

    ws.on('close', (code) => {
      if (this.stopped) return;
      this.stats.reconnects += 1;
      // 1 s, 2 s, 4 s ... capped at 30 s, with jitter so many clients do not retry in step.
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
      this.attempt += 1;
      this.log(`[${this.spec.name}] closed (${code}); reconnecting in ${Math.round(delay)} ms`);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }

  /** Stop and wait until the file is completely written. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.terminate();
    if (this.gzip && this.file) {
      const file = this.file;
      await new Promise<void>((resolve) => {
        file.on('close', () => resolve());
        this.gzip?.end();
      });
    }
  }
}
