import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { EventEnvelope, ReplayScenario, ReplayStatus } from '@ins/shared';
import type { Logger } from '../../logger.ts';

export interface ReplayOptions {
  /** gzipped NDJSON of event envelopes, sorted by time (made by tools/replay-prep). */
  files: Partial<Record<ReplayScenario, string>>;
  log: Logger;
  /**
   * Receives the events of one original message at a time. A returned
   * promise means "the queue is filling, wait": reading pauses until it
   * resolves, then the clock is re-anchored so the events are not stamped late.
   */
  sink(batch: EventEnvelope[], now: number, lossy: boolean): void | Promise<void>;
  /** Wall clock, overridable in tests. */
  now?: () => number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The part of an event ID shared by all events of one message: "replay:rrc05-x-0#3" -> "replay:rrc05-x-0". */
function messageOf(eid: string): string {
  const hash = eid.lastIndexOf('#');
  return hash > 0 ? eid.slice(0, hash) : eid;
}

/**
 * Plays a recorded incident through the live pipeline, as if it were
 * happening now.
 *
 * Every event is RETIMED: an event recorded at 15:39:12 on 4 Oct 2021, played
 * at 10x from 15:30:00, is stamped (now + 55.2 s). The pipeline, the windows,
 * the rooms and the detectors therefore treat it exactly like live traffic.
 * The original time is kept in `data.origTs`, the source stays `replay`, and
 * each run gets fresh event IDs (`replay:r<run>:...`) so a second run is not
 * dropped as a duplicate of the first.
 *
 * The file is streamed line by line (8.5 million events do not fit in
 * memory comfortably) and events are released when their time comes, so
 * reading never runs far ahead of playback.
 */
export class ReplayPlayer {
  private readonly opts: ReplayOptions;
  private readonly now: () => number;
  private status: ReplayStatus = {
    state: 'idle',
    scenario: null,
    speed: 1,
    clock: null,
    emitted: 0,
    run: 0,
    error: null,
    lossy: false,
    amplify: 1,
  };
  /** Playback maps original time to wall time through this anchor. */
  private anchor = { wall: 0, orig: 0 };
  private resumeWaiter: (() => void) | null = null;

  constructor(opts: ReplayOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  snapshot(): ReplayStatus {
    return { ...this.status };
  }

  /** Start a new run (stopping any current one). */
  start(scenario: ReplayScenario, speed: number, from: number, lossy = false, amplify = 1): void {
    const file = this.opts.files[scenario];
    if (!file || !existsSync(file)) {
      this.status = {
        ...this.status,
        state: 'error',
        error: `Replay file not found${file ? `: ${file}` : ''}. Run "pnpm replay-prep" first.`,
      };
      return;
    }
    this.wake(); // release a paused run so it can see it was replaced
    const run = this.status.run + 1;
    this.status = {
      state: 'loading',
      scenario,
      speed,
      clock: from,
      emitted: 0,
      run,
      error: null,
      lossy,
      amplify,
    };
    this.anchor = { wall: this.now(), orig: from };
    void this.play(run, file, from).catch((err: unknown) => {
      if (this.status.run !== run) return;
      this.opts.log.error({ err }, 'replay failed');
      this.status = { ...this.status, state: 'error', error: String(err) };
    });
  }

  pause(): void {
    if (this.status.state === 'playing' || this.status.state === 'loading') {
      this.status = { ...this.status, state: 'paused' };
    }
  }

  resume(): void {
    if (this.status.state !== 'paused') return;
    // Continue from where we stopped: re-anchor the clock to now.
    this.anchor = { wall: this.now(), orig: this.status.clock ?? this.anchor.orig };
    this.status = { ...this.status, state: 'playing' };
    this.wake();
  }

  stop(): void {
    if (this.status.state === 'idle') return;
    this.status = { ...this.status, state: 'idle', run: this.status.run + 1, clock: null };
    this.wake();
  }

  setSpeed(speed: number): void {
    // Re-anchor so the change applies from this moment, without a jump.
    this.anchor = { wall: this.now(), orig: this.origNow() };
    this.status = { ...this.status, speed };
  }

  /** The original time that corresponds to "now" at the current speed. */
  private origNow(): number {
    return this.anchor.orig + (this.now() - this.anchor.wall) * this.status.speed;
  }

  private wake(): void {
    this.resumeWaiter?.();
    this.resumeWaiter = null;
  }

  private async play(run: number, file: string, from: number): Promise<void> {
    const lines = createInterface({
      input: createReadStream(file).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    const current = () => this.status.run === run;
    let batch: EventEnvelope[] = [];
    let batchMessage = '';

    const flush = async () => {
      if (batch.length === 0) return;
      const wait = this.opts.sink(batch, this.now(), this.status.lossy);
      this.status.emitted += batch.length;
      batch = [];
      if (wait) {
        // Backpressure: the pipeline is behind. Wait, then carry on from here
        // (like a pause), so the next events are stamped with the real time.
        await wait;
        if (current() && this.status.state === 'playing') {
          this.anchor = { wall: this.now(), orig: this.status.clock ?? this.anchor.orig };
        }
      }
    };

    try {
      for await (const line of lines) {
        if (!current()) return;

        // Skip quickly to the start time without parsing whole lines.
        const ts = Number(/"ts":(\d+)/.exec(line)?.[1]);
        if (!Number.isFinite(ts) || ts < from) continue;
        if (this.status.state === 'loading') this.status.state = 'playing';

        // Wait until this event's moment has come, staying put while paused.
        // The due time is recomputed each round: speed changes and pauses move the anchor.
        for (;;) {
          if (!current()) return;
          if (this.status.state === 'paused') {
            await flush();
            await new Promise<void>((resolve) => (this.resumeWaiter = resolve));
            continue;
          }
          const wait = this.anchor.wall + (ts - this.anchor.orig) / this.status.speed - this.now();
          if (wait <= 0) break;
          await flush();
          await sleep(Math.min(wait, 50));
        }

        const original = JSON.parse(line) as EventEnvelope;
        const message = messageOf(original.eid);
        if (message !== batchMessage) {
          await flush();
          batchMessage = message;
        }
        const wall = this.anchor.wall + (ts - this.anchor.orig) / this.status.speed;
        const rest = original.eid.slice('replay:'.length);
        // Copy k > 0 exists only in amplified load tests; its ID marks it as a copy.
        for (let k = 0; k < this.status.amplify; k++) {
          batch.push({
            ...original,
            src: 'replay',
            eid: k === 0 ? `replay:r${run}:${rest}` : `replay:r${run}x${k}:${rest}`,
            ts: Math.round(wall),
            its: this.now(),
            data: { ...original.data, origTs: ts },
          });
        }
        this.status.clock = ts;
      }
      await flush();
      if (current()) this.status = { ...this.status, state: 'finished' };
    } finally {
      lines.close();
    }
  }
}
