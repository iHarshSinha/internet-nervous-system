/**
 * A token bucket: holds up to `burst` tokens and refills at `ratePerSec`.
 * Each action takes one token; with none left, the action is refused. It
 * allows short bursts but caps the sustained rate.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;

  constructor(ratePerSec: number, burst: number, now = Date.now()) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Counts new socket connections per client address in a sliding minute, so
 * one machine cannot open thousands of sockets. Old entries are swept away.
 */
export class ConnectionLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  allow(address: string, now = Date.now()): boolean {
    const recent = (this.hits.get(address) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(address, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(address, recent);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    for (const [address, times] of this.hits) {
      if (times.every((t) => now - t >= 60_000)) this.hits.delete(address);
    }
  }
}

/** The client's address. Behind exactly one proxy (Vite in dev, Caddy or Railway), it is the first forwarded address. */
export function clientAddress(
  headers: Record<string, string | string[] | undefined>,
  fallback: string,
): string {
  const forwarded = headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || fallback;
}
