import { describe, expect, it } from 'vitest';
import { googleLoginSchema, watchlistSchema } from './index.ts';

describe('watchlist', () => {
  const ok = {
    countries: ['IN', 'US'],
    asns: [13335],
    minSeverity: 'warning',
    discordWebhook: null,
  };

  it('accepts a normal watchlist and a Discord webhook', () => {
    expect(watchlistSchema.parse(ok)).toEqual(ok);
    const hook = 'https://discord.com/api/webhooks/123456789/abc-DEF_123';
    expect(watchlistSchema.safeParse({ ...ok, discordWebhook: hook }).success).toBe(true);
  });

  it('rejects webhooks that are not Discord, bad codes and oversized lists', () => {
    for (const discordWebhook of [
      'https://evil.example/api/webhooks/1/x',
      'http://discord.com/api/webhooks/1/x',
      'https://discord.com.evil.example/api/webhooks/1/x',
      'javascript:alert(1)',
    ]) {
      expect(watchlistSchema.safeParse({ ...ok, discordWebhook }).success, discordWebhook).toBe(
        false,
      );
    }
    expect(watchlistSchema.safeParse({ ...ok, countries: ['india'] }).success).toBe(false);
    expect(watchlistSchema.safeParse({ ...ok, asns: [-1] }).success).toBe(false);
    expect(watchlistSchema.safeParse({ ...ok, minSeverity: 'panic' }).success).toBe(false);
    const many = Array.from({ length: 31 }, (_, i) => i + 1);
    expect(watchlistSchema.safeParse({ ...ok, asns: many }).success).toBe(false);
  });
});

describe('google login', () => {
  it('requires a credential string of sane length', () => {
    expect(googleLoginSchema.safeParse({ credential: 'x'.repeat(40) }).success).toBe(true);
    expect(googleLoginSchema.safeParse({}).success).toBe(false);
    expect(googleLoginSchema.safeParse({ credential: 'x'.repeat(5000) }).success).toBe(false);
  });
});
