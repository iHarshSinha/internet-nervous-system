import { generateKeyPairSync } from 'node:crypto';
import { createMemoryIncidentStore } from '../db/incidents.ts';
import type { AddressInfo } from 'node:net';
import {
  EV,
  NAMESPACES,
  type ClientToServerEvents,
  type MeResponse,
  type ServerToClientEvents,
  type SessionResponse,
  type SubAck,
} from '@ins/shared';
import jwt from 'jsonwebtoken';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';
import type { Mongo } from '../db/client.ts';
import type { MetricsStore } from '../db/metrics.ts';
import { createLogger } from '../logger.ts';
import { buildServer, type RunningServer } from '../server.ts';
import { createGoogleVerifier, GoogleTokenError, type GoogleVerifier } from './google.ts';
import { createMemoryAuthStore } from './store.ts';
import { createMemoryRunsStore } from '../scenarios/runs.ts';

// ---- the Google verifier, against a locally generated key standing in for Google's

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const fakeCerts = (async () =>
  new Response(JSON.stringify({ keys: [jwk] }), {
    headers: { 'cache-control': 'public, max-age=3600' },
  })) as unknown as typeof fetch;

function googleToken(claims: Record<string, unknown>, opts: jwt.SignOptions = {}): string {
  return jwt.sign(
    {
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada',
      picture: 'https://x/p.png',
      ...claims,
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'k1',
      issuer: 'https://accounts.google.com',
      audience: CLIENT_ID,
      subject: 'google-123',
      expiresIn: 300,
      ...opts,
    },
  );
}

describe('Google ID token verification', () => {
  const verify = createGoogleVerifier(CLIENT_ID, fakeCerts);

  it('accepts a valid token and returns the identity', async () => {
    expect(await verify(googleToken({}))).toEqual({
      sub: 'google-123',
      email: 'ada@example.com',
      name: 'Ada',
      picture: 'https://x/p.png',
    });
  });

  it('rejects a token issued for another app', async () => {
    await expect(verify(googleToken({}, { audience: 'someone-else' }))).rejects.toThrow(
      GoogleTokenError,
    );
  });

  it('rejects an expired token, an unverified email and a wrong issuer', async () => {
    await expect(verify(googleToken({}, { expiresIn: -10 }))).rejects.toThrow(GoogleTokenError);
    await expect(verify(googleToken({ email_verified: false }))).rejects.toThrow(/not verified/);
    await expect(verify(googleToken({}, { issuer: 'https://evil.example' }))).rejects.toThrow(
      GoogleTokenError,
    );
  });

  it('rejects a token signed with a key Google does not publish', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = jwt.sign({ email: 'a@b.c', email_verified: true }, other, {
      algorithm: 'RS256',
      keyid: 'k1',
      issuer: 'accounts.google.com',
      audience: CLIENT_ID,
      subject: 'x',
    });
    await expect(verify(forged)).rejects.toThrow(GoogleTokenError);
    await expect(verify('not-a-jwt')).rejects.toThrow(GoogleTokenError);
  });
});

// ---- the sign-in flow, sessions, roles and namespaces, on a real server

const fakeGoogle: GoogleVerifier = async (credential) => {
  if (credential === 'google-token-user-xxxxxxxxxxxxxxxx') {
    return { sub: 'g-user', email: 'user@example.com', name: 'User', picture: null };
  }
  if (credential === 'google-token-admin-xxxxxxxxxxxxxxx') {
    return { sub: 'g-admin', email: 'boss@example.com', name: 'Boss', picture: null };
  }
  throw new GoogleTokenError('bad token');
};

const mongo = { ping: async () => true, close: async () => {} } as unknown as Mongo;
const store = {
  ensureIndexes: async () => {},
  writeMinute: async () => 0,
  readMinutes: async () => [],
  stats: { windows: 0, docs: 0, errors: 0, lastWriteMs: null },
} as MetricsStore;

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

async function start(env: Record<string, string>) {
  const config = loadConfig({
    NODE_ENV: 'test',
    MODE: 'replay',
    GOOGLE_CLIENT_ID: CLIENT_ID,
    ADMIN_EMAILS: 'Boss@Example.com',
    REPLAY_FACEBOOK_FILE: '/nonexistent/replay.ndjson.gz',
    ...env,
  });
  const server = buildServer({
    config,
    log: createLogger(config),
    mongo,
    store,
    authStore: createMemoryAuthStore(),
    runsStore: createMemoryRunsStore(),
    incidentStore: createMemoryIncidentStore(),
    verifyGoogle: fakeGoogle,
    heartbeatMs: 20,
    conflateMs: 20,
  });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
  return { server, url };
}

const generous = {
  API_RATE_PER_MIN: '100000',
  AUTH_RATE_PER_MIN: '100000',
  SOCKET_CONNECTIONS_PER_MIN: '100000',
  SOCKET_MESSAGES_PER_SEC: '100000',
};

const post = (url: string, body?: unknown, cookie?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

function socketTo(url: string, ns: string, token?: string): Promise<Client> {
  const client: Client = connect(url + ns, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...(token && { auth: { token } }),
  });
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('connect_error', (err) => {
      client.close();
      reject(err);
    });
  });
}

describe('sign-in, sessions and roles', () => {
  let server: RunningServer;
  let url: string;
  beforeAll(async () => ({ server, url } = await start(generous)));
  afterAll(() => server.close());

  const signIn = async (credential: string) => {
    const res = await post(`${url}/api/auth/google`, { credential });
    return { res, body: (await res.json()) as SessionResponse, cookie: cookieOf(res) };
  };

  it('publishes the Google client ID so the page can show the button', async () => {
    expect(await (await fetch(`${url}/api/auth/config`)).json()).toEqual({
      googleClientId: CLIENT_ID,
    });
  });

  it('starts a session for a valid Google token, with a locked-down refresh cookie', async () => {
    const { res, body } = await signIn('google-token-user-xxxxxxxxxxxxxxxx');
    expect(res.status).toBe(200);
    expect(body.user).toMatchObject({ email: 'user@example.com', role: 'user' });
    expect(body.accessToken.split('.')).toHaveLength(3);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^ins_refresh=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
  });

  it('rejects a bad Google token and a malformed body', async () => {
    expect((await post(`${url}/api/auth/google`, { credential: 'x'.repeat(40) })).status).toBe(401);
    expect((await post(`${url}/api/auth/google`, { nope: 1 })).status).toBe(400);
  });

  it('makes accounts listed in ADMIN_EMAILS admins (case-insensitive)', async () => {
    const { body } = await signIn('google-token-admin-xxxxxxxxxxxxxxx');
    expect(body.user.role).toBe('admin');
  });

  it('protects /api/me and lets a user edit their watchlist', async () => {
    const { body } = await signIn('google-token-user-xxxxxxxxxxxxxxxx');
    const auth = {
      authorization: `Bearer ${body.accessToken}`,
      'content-type': 'application/json',
    };

    expect((await fetch(`${url}/api/me`)).status).toBe(401);
    const forged = jwt.sign({ role: 'admin' }, 'x'.repeat(40), {
      subject: body.user.id,
      issuer: 'ins',
    });
    expect(
      (await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${forged}` } })).status,
    ).toBe(401);

    const me = (await (await fetch(`${url}/api/me`, { headers: auth })).json()) as MeResponse;
    expect(me.watchlist).toEqual({
      countries: [],
      asns: [],
      minSeverity: 'warning',
      discordWebhook: null,
    });

    const watchlist = {
      countries: ['IN', 'IN', 'DE'],
      asns: [13335],
      minSeverity: 'critical',
      discordWebhook: null,
    };
    const saved = await fetch(`${url}/api/me/watchlist`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify(watchlist),
    });
    expect(await saved.json()).toMatchObject({ countries: ['IN', 'DE'], asns: [13335] });
    const bad = await fetch(`${url}/api/me/watchlist`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ ...watchlist, discordWebhook: 'https://evil.example/hook' }),
    });
    expect(bad.status).toBe(400);
  });

  it('rotates refresh tokens: each works once, and logout ends the session', async () => {
    const { cookie } = await signIn('google-token-user-xxxxxxxxxxxxxxxx');
    const first = await post(`${url}/api/auth/refresh`, undefined, cookie);
    expect(first.status).toBe(200);
    const next = cookieOf(first);
    expect(next).not.toBe(cookie);

    expect((await post(`${url}/api/auth/refresh`, undefined, cookie)).status).toBe(401); // already used
    expect((await post(`${url}/api/auth/logout`, undefined, next)).status).toBe(204);
    expect((await post(`${url}/api/auth/refresh`, undefined, next)).status).toBe(401); // logged out
  });

  it('keeps the admin API for admins', async () => {
    const user = await signIn('google-token-user-xxxxxxxxxxxxxxxx');
    const admin = await signIn('google-token-admin-xxxxxxxxxxxxxxx');
    const get = (token: string) =>
      fetch(`${url}/api/admin/stats`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get(user.body.accessToken)).status).toBe(403);
    const ok = await get(admin.body.accessToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty('pipeline');
  });

  it('lets only admins control the replay, and validates commands', async () => {
    const user = await signIn('google-token-user-xxxxxxxxxxxxxxxx');
    const admin = await signIn('google-token-admin-xxxxxxxxxxxxxxx');
    const send = (token: string, body: unknown) =>
      fetch(`${url}/api/admin/replay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const start = { action: 'start', scenario: 'facebook-2021', speed: 10 };

    expect((await send(user.body.accessToken, start)).status).toBe(403);
    expect(
      (await send(admin.body.accessToken, { action: 'start', scenario: 'nope', speed: 10 })).status,
    ).toBe(400);
    expect((await send(admin.body.accessToken, { ...start, speed: 7 })).status).toBe(400);

    // The file is missing in tests: the player reports it instead of crashing.
    const res = await send(admin.body.accessToken, start);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/not found/),
    });
  });

  it('lets admins trigger a scenario, and lists the simulated stretch publicly', async () => {
    const user = await signIn('google-token-user-xxxxxxxxxxxxxxxx');
    const admin = await signIn('google-token-admin-xxxxxxxxxxxxxxx');
    const send = (token: string, body: unknown) =>
      fetch(`${url}/api/admin/scenario`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const start = { action: 'start', scenario: 'facebook-2021' };
    expect((await send(user.body.accessToken, start)).status).toBe(403);
    expect((await send(admin.body.accessToken, { action: 'start', scenario: 'nope' })).status).toBe(
      400,
    );

    const res = await send(admin.body.accessToken, start);
    expect(await res.json()).toMatchObject({
      state: 'running',
      id: 'facebook-2021',
      phase: 'priming',
    });
    await new Promise((r) => setTimeout(r, 50));
    const runs = (await (await fetch(`${url}/api/scenarios/runs`)).json()) as {
      scenario: string;
    }[];
    expect(runs.map((r) => r.scenario)).toContain('facebook-2021');

    const stopped = await send(admin.body.accessToken, { action: 'stop' });
    expect(await stopped.json()).toMatchObject({ state: 'idle' });
  });

  it('guards the /user and /admin namespaces with the access token', async () => {
    const user = await signIn('google-token-user-xxxxxxxxxxxxxxxx');
    const admin = await signIn('google-token-admin-xxxxxxxxxxxxxxx');

    await expect(socketTo(url, NAMESPACES.user)).rejects.toThrow('unauthorized');
    (await socketTo(url, NAMESPACES.user, user.body.accessToken)).close();
    await expect(socketTo(url, NAMESPACES.admin, user.body.accessToken)).rejects.toThrow(
      'forbidden',
    );

    // Admins are placed in the ops room and start receiving pipeline numbers.
    const ops = await socketTo(url, NAMESPACES.admin, admin.body.accessToken);
    const frame = await new Promise<{ r: string }>((resolve) => ops.once(EV.frame, resolve));
    expect(frame.r).toBe('ops');
    ops.close();
  });
});

describe('rate limits', () => {
  let server: RunningServer;
  let url: string;
  beforeAll(
    async () =>
      ({ server, url } = await start({
        ...generous,
        AUTH_RATE_PER_MIN: '3',
        SOCKET_MESSAGES_PER_SEC: '2',
        SOCKET_CONNECTIONS_PER_MIN: '3',
      })),
  );
  afterAll(() => server.close());

  it('limits sign-in attempts per address', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push((await post(`${url}/api/auth/google`, { credential: 'x'.repeat(40) })).status);
    expect(codes).toEqual([401, 401, 401, 429]);
  });

  it('does not count session refreshes against the sign-in limit', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post(`${url}/api/auth/refresh`)).status).toBe(204); // no cookie: no session, never 429
    }
  });

  it('limits sub/unsub/resync per socket, and new sockets per address', async () => {
    const client = await socketTo(url, NAMESPACES.live);
    const sub = () =>
      new Promise<SubAck>((resolve) => client.emit(EV.sub, { rooms: ['world'] }, resolve));
    const replies = [await sub(), await sub(), await sub()];
    expect(replies.map((r) => r.ok || r.error.code)).toEqual([true, true, 'rate_limited']);

    // One socket is already open from this address; two more fit in the minute, the next does not.
    const extra = [await socketTo(url, NAMESPACES.live), await socketTo(url, NAMESPACES.live)];
    await expect(socketTo(url, NAMESPACES.live)).rejects.toThrow('rate_limited');
    for (const s of [client, ...extra]) s.close();
  });
});

describe('configuration', () => {
  it('treats empty variables (as Docker Compose passes them) as unset', () => {
    const c = loadConfig({ NODE_ENV: 'production', GOOGLE_CLIENT_ID: '', JWT_SECRET: '' });
    expect(c.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(c.JWT_SECRET_GENERATED).toBe(true);
    expect(c.JWT_SECRET).toHaveLength(64);
    expect(c.COOKIE_SECURE).toBe(true);
  });

  it('rejects a short secret and a malformed client ID', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: 'my-app' })).toThrow(/GOOGLE_CLIENT_ID/);
  });
});
