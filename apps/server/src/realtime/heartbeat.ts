import { EV, rooms, type Delta, type Frame } from '@ins/shared';
import type { LiveNamespace } from './live.ts';
import type { RoomSequencer } from './sequencer.ts';

/**
 * Phase 0 stand-in for real telemetry: one small frame to the `world` room
 * every second. It proves the whole delivery path (rooms, sequence numbers,
 * the proxy, the browser worker) before any real data flows through it.
 *
 * It already follows the delta rule: the tick changes every time and is always
 * sent; the number of connected clients is sent only when it has changed.
 */
export function startHeartbeat(
  live: LiveNamespace,
  seq: RoomSequencer,
  intervalMs = 1000,
): () => void {
  let tick = 0;
  let lastSockets = -1;

  const timer = setInterval(() => {
    tick += 1;
    const changes: Delta[] = [['sys', 'tick', tick]];

    const sockets = live.sockets.size;
    if (sockets !== lastSockets) {
      changes.push(['sys', 'sockets', sockets]);
      lastSockets = sockets;
    }

    const frame: Frame = { r: rooms.world, s: seq.next(rooms.world), t: Date.now(), d: changes };
    live.to(rooms.world).emit(EV.frame, frame);
  }, intervalMs);

  return () => clearInterval(timer);
}
