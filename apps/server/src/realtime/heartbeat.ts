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

  // A client that has just joined has no state yet, so "unchanged" values
  // would never reach it. Until Phase 1 adds a proper snapshot, forget what
  // we last sent whenever someone joins, so the next frame carries it again.
  const onJoin = (room: string) => {
    if (room === rooms.world) lastSockets = -1;
  };
  live.adapter.on('join-room', onJoin);

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

  return () => {
    clearInterval(timer);
    live.adapter.off('join-room', onJoin);
  };
}
