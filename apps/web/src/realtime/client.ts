import { rooms } from '@ins/shared';
import { proxy, wrap } from 'comlink';
import { useLive } from '../store/live.ts';
import type { SocketWorkerApi } from '../workers/socket.worker.ts';

let started = false;

/**
 * Start the socket worker and feed its batched updates into the store.
 * Comlink lets us call the worker's functions as if they were local; `proxy`
 * passes our callback across the thread boundary.
 */
export function startRealtime(): void {
  if (started) return;
  started = true;

  const worker = new Worker(new URL('../workers/socket.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ins-socket',
  });
  const api = wrap<SocketWorkerApi>(worker);

  void api.start(proxy((update) => useLive.getState().apply(update)));
  void api.subscribe([rooms.world]);
}
