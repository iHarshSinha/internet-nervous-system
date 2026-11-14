import type { WorkerUpdate } from '../workers/socket.worker.ts';

/**
 * Several worker updates as one: every frame and feed batch in arrival
 * order, and the newest link status and counters. Applying the result is
 * the same as applying each update in turn, with one render instead of many.
 */
export function mergeUpdates(batch: readonly WorkerUpdate[]): WorkerUpdate | null {
  const last = batch.at(-1);
  if (!last) return null;
  return {
    ...last,
    frames: batch.flatMap((u) => u.frames),
    feed: batch.flatMap((u) => u.feed),
  };
}
