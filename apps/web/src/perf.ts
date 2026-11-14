/*
 * Client render budget, measured. Every live update the page applies is
 * timed here, alongside the browser's own "long task" reports (main-thread
 * work over 50 ms). The HUD (press ~) shows these numbers; they are also on
 * `window.__perf` for measurements.
 */

interface Second {
  /** Store updates applied (each is one React render at most). */
  applies: number;
  /** Frames from the server inside those updates. */
  frames: number;
  /** Time spent applying, ms. */
  costs: number[];
  /** Animation frames the browser drew. */
  paints: number;
}

const empty = (): Second => ({ applies: 0, frames: 0, costs: [], paints: 0 });
let current = empty();
let last = empty();
let longTasks = 0;
let longTaskMs = 0;

// Roll the window every second.
setInterval(() => {
  last = current;
  current = empty();
}, 1000);

// Count painted frames (only while visible: browsers pause this in hidden tabs).
const countPaint = () => {
  current.paints += 1;
  requestAnimationFrame(countPaint);
};
requestAnimationFrame(countPaint);

try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks += 1;
      longTaskMs += entry.duration;
    }
  }).observe({ type: 'longtask', buffered: true });
} catch {
  // Not every browser reports long tasks (Safari, Firefox); the rest still works.
}

/** Run `apply` (one store update) and record how long it took and how many frames it carried. */
export function measured(frames: number, apply: () => void): void {
  const t0 = performance.now();
  apply();
  current.applies += 1;
  current.frames += frames;
  current.costs.push(performance.now() - t0);
}

export interface PerfSnapshot {
  /** Over the last full second. */
  fps: number;
  appliesPerSec: number;
  framesPerSec: number;
  applyP50Ms: number;
  applyP95Ms: number;
  applyMaxMs: number;
  /** Since the page loaded. */
  longTasks: number;
  longTaskMs: number;
}

export function perfSnapshot(): PerfSnapshot {
  const costs = [...last.costs].sort((a, b) => a - b);
  const q = (p: number) =>
    costs.length === 0
      ? 0
      : Math.round(costs[Math.min(costs.length - 1, Math.floor(p * costs.length))]! * 100) / 100;
  return {
    fps: last.paints,
    appliesPerSec: last.applies,
    framesPerSec: last.frames,
    applyP50Ms: q(0.5),
    applyP95Ms: q(0.95),
    applyMaxMs: costs.length ? Math.round(costs.at(-1)! * 100) / 100 : 0,
    longTasks,
    longTaskMs: Math.round(longTaskMs),
  };
}

(window as unknown as { __perf: () => PerfSnapshot }).__perf = perfSnapshot;
