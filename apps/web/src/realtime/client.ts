import { rooms } from '@ins/shared';
import { proxy, wrap, type Remote } from 'comlink';
import { useLive } from '../store/live.ts';
import type { SocketWorkerApi } from '../workers/socket.worker.ts';

let api: Remote<SocketWorkerApi> | null = null;

/**
 * Start the socket worker and feed its batched updates into the store.
 * Comlink lets us call the worker's functions as if they were local; `proxy`
 * passes our callback across the thread boundary.
 */
export function startRealtime(): void {
  if (api) return;
  const worker = new Worker(new URL('../workers/socket.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ins-socket',
  });
  api = wrap<SocketWorkerApi>(worker);
  void api.start(proxy((update) => useLive.getState().apply(update)));
  void api.subscribe([rooms.world]);
}

/** Join rooms; resolves with their current sequence numbers. */
export function subscribe(roomNames: string[]): Promise<Record<string, number>> {
  startRealtime();
  return api!.subscribe(roomNames);
}

export function unsubscribe(roomNames: string[]): void {
  void api?.unsubscribe(roomNames);
}
