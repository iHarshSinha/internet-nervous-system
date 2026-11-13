import { useEffect, useState } from 'react';

/** Re-render every `ms`. For views that read fast-changing mutable stores at a calm pace. */
export function useTick(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}
