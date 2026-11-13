import { googleLoginSchema, type AuthConfig, type SessionResponse } from '@ins/shared';
import { Router, type Response } from 'express';
import type { AuthStore } from '../auth/store.ts';
import { GoogleTokenError, type GoogleVerifier } from '../auth/google.ts';
import { readCookie } from '../auth/middleware.ts';
import { hashToken, newRefreshToken, REFRESH_TTL_MS, signAccessToken } from '../auth/tokens.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';

export const REFRESH_COOKIE = 'ins_refresh';

export interface AuthDeps {
  config: Config;
  log: Logger;
  store: AuthStore;
  /** Null when no Google client ID is configured: sign-in is then switched off. */
  verifyGoogle: GoogleVerifier | null;
}

/**
 * Sign-in with Google, and our own sessions on top of it.
 *
 *  - POST /api/auth/google  verify Google's ID token, create or update the
 *    user, start a session.
 *  - POST /api/auth/refresh  swap the refresh cookie for a new access token
 *    AND a new refresh cookie (rotation: each refresh token works once).
 *  - POST /api/auth/logout  end the session.
 *
 * The access token (15 min) is returned in the body and kept in memory by the
 * page. The refresh token (7 days) lives only in an httpOnly cookie that page
 * scripts cannot read, limited to /api/auth, and only its hash is stored.
 */
export function authRouter({ config, log, store, verifyGoogle }: AuthDeps): Router {
  const router = Router();

  const setCookie = (res: Response, token: string | null) => {
    const base = {
      httpOnly: true,
      sameSite: 'strict' as const,
      secure: config.COOKIE_SECURE,
      path: '/api/auth',
    };
    if (token) res.cookie(REFRESH_COOKIE, token, { ...base, maxAge: REFRESH_TTL_MS });
    else res.clearCookie(REFRESH_COOKIE, base);
  };

  async function startSession(
    res: Response,
    user: SessionResponse['user'],
  ): Promise<SessionResponse> {
    const refresh = newRefreshToken();
    await store.saveRefreshToken(
      hashToken(refresh),
      user.id,
      new Date(Date.now() + REFRESH_TTL_MS),
    );
    setCookie(res, refresh);
    const access = signAccessToken(
      { id: user.id, role: user.role, email: user.email },
      config.JWT_SECRET,
    );
    return { accessToken: access.token, expiresAt: access.expiresAt, user };
  }

  router.get('/api/auth/config', (_req, res) => {
    const body: AuthConfig = { googleClientId: config.GOOGLE_CLIENT_ID ?? null };
    res.json(body);
  });

  router.post('/api/auth/google', async (req, res) => {
    if (!verifyGoogle) {
      res.status(503).json({ error: { code: 'not_configured', message: 'Sign-in is not set up' } });
      return;
    }
    const body = googleLoginSchema.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: { code: 'bad_request', message: 'Missing Google credential' } });
      return;
    }
    let identity;
    try {
      identity = await verifyGoogle(body.data.credential);
    } catch (err) {
      if (!(err instanceof GoogleTokenError)) throw err;
      log.info({ reason: err.message }, 'rejected Google sign-in');
      res
        .status(401)
        .json({ error: { code: 'unauthorized', message: 'Google sign-in was not accepted' } });
      return;
    }
    const role = config.ADMIN_EMAILS.includes(identity.email) ? 'admin' : 'user';
    const user = await store.upsertGoogleUser(identity, role);
    log.info({ userId: user.id, role }, 'signed in');
    res.json(await startSession(res, user));
  });

  router.post('/api/auth/refresh', async (req, res) => {
    const token = readCookie(req.get('cookie'), REFRESH_COOKIE);
    const userId = token ? await store.takeRefreshToken(hashToken(token)) : null;
    const user = userId ? await store.getUser(userId) : null;
    if (!user) {
      setCookie(res, null);
      res.status(401).json({ error: { code: 'unauthorized', message: 'No session' } });
      return;
    }
    res.json(await startSession(res, user));
  });

  router.post('/api/auth/logout', async (req, res) => {
    const token = readCookie(req.get('cookie'), REFRESH_COOKIE);
    if (token) await store.deleteRefreshToken(hashToken(token));
    setCookie(res, null);
    res.status(204).end();
  });

  return router;
}
