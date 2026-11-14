import WebSocket from 'ws';
import type { Logger } from '../../logger.ts';

export interface UpstreamSocketOptions {
  /** Short name for logs and metrics, for example "ris:rrc00". */
  name: string;
  url: string;
  log: Logger;
  /** Called every time the connection opens, to (re)send subscriptions. */
  subscribe(send: (message: unknown) => void): void;
  /** Called for every text message. */
  onText(text: string, receivedAt: number): void;
  /** First retry delay; doubles on every failed attempt. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Reconnect if nothing at all (not even a pong) arrives for this long. */
  idleTimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface UpstreamSocketStats {
  connected: boolean;
  /** Times the connection was lost or could not be opened. */
  reconnects: number;
  messages: number;
  bytes: number;
  lastMessageAt: number | null;
}

/**
 * A WebSocket client that never gives up.
 *
 * Phase 0 measured why this matters: RIS Live answered some connection
 * attempts with HTTP 502 and dropped busy connections several times in ten
 * minutes. So this class reconnects with exponential backoff plus jitter,
 * re-sends its subscriptions after every reconnect, and uses ping/pong plus an
 * idle timer to notice a connection that is open but silently dead.
 */
export class UpstreamSocket {
  readonly name: string;
  readonly stats: UpstreamSocketStats = {
    connected: false,
    reconnects: 0,
    messages: 0,
    bytes: 0,
    lastMessageAt: null,
  };

  private readonly opts: Required<UpstreamSocketOptions>;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private lastActivity = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(options: UpstreamSocketOptions) {
    this.name = options.name;
    this.opts = {
      baseDelayMs: 1000,
      // At most 10 s between attempts: after an outage the feed is back within about 10 s
      // of the network (load test T6 measured 18.5 s with a 30 s ceiling), and one try
      // every 10 s per connection is still gentle on RIS Live.
      maxDelayMs: 10_000,
      idleTimeoutMs: 60_000,
      pingIntervalMs: 20_000,
      ...options,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkAlive(), this.opts.pingIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.terminate();
    this.ws = null;
    this.stats.connected = false;
  }

  private connect(): void {
    const { name, log } = this.opts;
    const ws = new WebSocket(this.opts.url, { perMessageDeflate: false });
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.stats.connected = true;
      this.lastActivity = Date.now();
      log.info({ source: name }, 'upstream connected');
      this.opts.subscribe((message) => ws.send(JSON.stringify(message)));
    });

    ws.on('message', (raw: Buffer) => {
      const now = Date.now();
      this.lastActivity = now;
      this.stats.messages += 1;
      this.stats.bytes += raw.length;
      this.stats.lastMessageAt = now;
      this.opts.onText(raw.toString('utf8'), now);
    });

    ws.on('pong', () => {
      this.lastActivity = Date.now();
    });

    // 'error' is always followed by 'close', so reconnecting is handled there.
    ws.on('error', (err) => log.warn({ source: name, err: err.message }, 'upstream socket error'));

    ws.on('close', (code) => {
      this.stats.connected = false;
      if (this.stopped || this.ws !== ws) return;
      this.stats.reconnects += 1;

      // 1 s, 2 s, 4 s ... capped, then randomised between 50% and 100% so that
      // many clients cut off at the same moment do not all retry together.
      const ceiling = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** this.attempt);
      const delay = Math.round(ceiling * (0.5 + Math.random() / 2));
      this.attempt += 1;
      log.warn({ source: name, code, retryInMs: delay }, 'upstream closed; will reconnect');
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private checkAlive(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastActivity > this.opts.idleTimeoutMs) {
      this.opts.log.warn({ source: this.name }, 'upstream silent for too long; reconnecting');
      ws.terminate(); // triggers 'close', which schedules the reconnect
      return;
    }
    ws.ping();
  }
}
