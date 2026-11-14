import type { ClientToServerEvents, Frame, ServerToClientEvents, SubAck } from '@ins/shared';
import { io, type Socket } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import { Distribution, SeqChecker } from './stats.ts';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface SwarmOptions {
  base: string;
  clients: number;
  /** The rooms client number i joins. */
  roomsFor(i: number): string[];
  /** Spread the connections over this long, so the server is not hit by one wall of handshakes. */
  rampMs: number;
  parser: 'msgpack' | 'json';
  /** Server clock minus ours (ms), to measure delivery delay across machines. */
  offsetMs: number;
}

export interface SwarmResult {
  clients: number;
  connected: number;
  connectErrors: number;
  disconnects: number;
  reconnects: number;
  /** Frames received by all clients together. */
  frames: number;
  framesPerClientPerSec: number;
  /** Bytes received, all clients (Engine.IO packet payloads). */
  bytesPerClientPerSec: number;
  /** Server stamping a frame -> a client receiving it, ms. */
  deliveryMs: ReturnType<Distribution['summary']>;
  gaps: number;
  duplicates: number;
  feedBatches: number;
  /** How long the measurement covered, s (after the ramp). */
  seconds: number;
}

/**
 * Many Socket.IO clients, each behaving like a browser tab: connect over
 * WebSocket with the server's wire format, join a few rooms, and check every
 * frame (in order, no gaps, no duplicates) while timing how long it took to
 * arrive. They run in this one process, which can hold a few thousand.
 */
export async function runSwarm(
  opts: SwarmOptions,
  measureMs: number,
  onProgress?: (r: SwarmResult) => void,
): Promise<SwarmResult> {
  const delivery = new Distribution();
  const clients: Client[] = [];
  const checkers: SeqChecker[] = [];
  let connected = 0;
  let connectErrors = 0;
  let disconnects = 0;
  let reconnects = 0;
  let bytes = 0;
  let feedBatches = 0;
  let measuring = false;

  const join = (c: Client, checker: SeqChecker, rooms: string[]) =>
    new Promise<void>((resolve) => {
      c.emit('sub', { rooms }, (ack: SubAck) => {
        if (ack.ok) checker.start(ack.seqs);
        resolve();
      });
    });

  for (let i = 0; i < opts.clients; i++) {
    const rooms = opts.roomsFor(i);
    const checker = new SeqChecker();
    const c: Client = io(`${opts.base}/live`, {
      transports: ['websocket'],
      forceNew: true,
      reconnectionDelay: 500,
      ...(opts.parser === 'msgpack' && { parser: msgpackParser }),
    });
    let everConnected = false;
    c.on('connect', () => {
      if (everConnected) reconnects += 1;
      else connected += 1;
      everConnected = true;
      // After a long drop the server has forgotten our rooms: join again (as the web worker does).
      if (!c.recovered) void join(c, checker, rooms);
    });
    c.on('connect_error', () => (connectErrors += 1));
    c.on('disconnect', () => (disconnects += 1));
    c.on('f', (frame: Frame) => {
      checker.check(frame);
      if (measuring) delivery.add(Date.now() + opts.offsetMs - frame.t);
    });
    c.on('e', () => (feedBatches += 1));
    // Count what arrives on the wire (string for JSON, binary for MessagePack). Each
    // (re)connection has a new Engine.IO socket, so listen again on every open.
    c.io.on('open', () => {
      c.io.engine.on('packet', (p: { data?: unknown }) => {
        if (!measuring) return;
        const d = p.data;
        if (typeof d === 'string') bytes += Buffer.byteLength(d);
        else if (d instanceof ArrayBuffer) bytes += d.byteLength;
        else if (ArrayBuffer.isView(d)) bytes += d.byteLength;
      });
    });
    clients.push(c);
    checkers.push(checker);
    if (opts.rampMs > 0) await new Promise((r) => setTimeout(r, opts.rampMs / opts.clients));
  }

  // Settle, then measure.
  await new Promise((r) => setTimeout(r, 2000));
  for (const ch of checkers) {
    ch.frames = 0;
    ch.gaps = 0;
    ch.duplicates = 0;
  }
  measuring = true;
  const started = Date.now();

  const result = (): SwarmResult => {
    const seconds = Math.max(0.001, (Date.now() - started) / 1000);
    const frames = checkers.reduce((n, ch) => n + ch.frames, 0);
    return {
      clients: opts.clients,
      connected,
      connectErrors,
      disconnects,
      reconnects,
      frames,
      framesPerClientPerSec: Math.round((frames / opts.clients / seconds) * 100) / 100,
      bytesPerClientPerSec: Math.round(bytes / opts.clients / seconds),
      deliveryMs: delivery.summary(),
      gaps: checkers.reduce((n, ch) => n + ch.gaps, 0),
      duplicates: checkers.reduce((n, ch) => n + ch.duplicates, 0),
      feedBatches,
      seconds: Math.round(seconds * 10) / 10,
    };
  };

  const progress = onProgress ? setInterval(() => onProgress(result()), 5000) : null;
  await new Promise((r) => setTimeout(r, measureMs));
  if (progress) clearInterval(progress);
  measuring = false;
  const final = result();
  for (const c of clients) c.close();
  return final;
}
