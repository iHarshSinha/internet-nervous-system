import { rooms } from '@ins/shared';
import { proxy, wrap, type Remote } from 'comlink';
import { useAuth } from '../store/auth.ts';
import { loadIncidents } from '../store/incidents.ts';
import { loadRadar } from '../store/radar.ts';
import { useLive } from '../store/live.ts';
import { measured } from '../perf.ts';
import { mergeUpdates } from './merge.ts';
import type { SocketWorkerApi, WorkerUpdate } from '../workers/socket.worker.ts';

let api: Remote<SocketWorkerApi> | null = null;

/*
 * Render budget: however many updates the worker sends, the page applies
 * them at most once per animation frame, merged into ONE store update (so at
 * most one React render per frame). In a hidden tab animation frames stop,
 * so updates are applied once a second instead: the state stays current and
 * the queue cannot grow, but nothing is drawn that nobody can see.
 */
const HIDDEN_APPLY_MS = 1000;
let queued: WorkerUpdate[] = [];
let scheduled = false;

function applyQueued(): void {
  scheduled = false;
  if (queued.length === 0) return;
  const merged = mergeUpdates(queued);
  queued = [];
  if (merged) measured(merged.frames.length, () => useLive.getState().apply(merged));
}

function enqueue(update: WorkerUpdate): void {
  queued.push(update);
  if (scheduled) return;
  scheduled = true;
  if (document.hidden) setTimeout(applyQueued, HIDDEN_APPLY_MS);
  else requestAnimationFrame(applyQueued);
}

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
  void api.start(proxy(enqueue));
  void api.subscribe([rooms.world]);
  // Incidents are part of every page: join the room first, then load what is already open,
  // so nothing that happens in between is missed (newer copies win the merge).
  void api.subscribe([rooms.incidents]).then(() => loadIncidents());
  void api.subscribe([rooms.arcs]).then(() => loadRadar());

  // Keep the personal channel in step with the session: open it on sign-in,
  // hand it each renewed token, close it on sign-out.
  const sync = (token: string | null) => void api?.connectUser(token);
  sync(useAuth.getState().accessToken);
  useAuth.subscribe((state, prev) => {
    if (state.accessToken !== prev.accessToken) sync(state.accessToken);
  });
}

/** Join rooms; resolves with their current sequence numbers. */
export function subscribe(roomNames: string[]): Promise<Record<string, number>> {
  startRealtime();
  return api!.subscribe(roomNames);
}

export function unsubscribe(roomNames: string[]): void {
  void api?.unsubscribe(roomNames);
}
