import { create } from 'zustand';

/**
 * The difference between the server's clock and this browser's.
 *
 * Every frame is stamped with the server's time. "Delivery delay" is the
 * time now minus that stamp, which is only meaningful if both clocks agree;
 * laptops are often off by a second or more. So we ask the server for its
 * time a few times and take the answer with the shortest round trip: the
 * server read its clock somewhere inside that trip, most likely the middle.
 *
 *   offset = serverTime - (sentAt + receivedAt) / 2      (error at most rtt / 2)
 */
export const useClock = create<{ offsetMs: number | null; rttMs: number | null }>(() => ({
  offsetMs: null,
  rttMs: null,
}));

async function sample(): Promise<{ offset: number; rtt: number } | null> {
  const sentAt = performance.timeOrigin + performance.now();
  try {
    const res = await fetch('/api/time', { cache: 'no-store' });
    const receivedAt = performance.timeOrigin + performance.now();
    if (!res.ok) return null;
    const { t } = (await res.json()) as { t: number };
    return { offset: t - (sentAt + receivedAt) / 2, rtt: receivedAt - sentAt };
  } catch {
    return null;
  }
}

/** Measure 5 times and keep the sample with the shortest round trip. */
export async function syncClock(): Promise<void> {
  let best: { offset: number; rtt: number } | null = null;
  for (let i = 0; i < 5; i++) {
    const s = await sample();
    if (s && (!best || s.rtt < best.rtt)) best = s;
  }
  if (best) {
    useClock.setState({ offsetMs: Math.round(best.offset), rttMs: Math.round(best.rtt) });
  }
}

/** The server's time now, as well as we know it. */
export function serverNow(): number {
  return Date.now() + (useClock.getState().offsetMs ?? 0);
}
