import type { RequestHandler, Response } from 'express';
import { verifyAccessToken, type Principal } from './tokens.ts';

/** The signed-in caller, as set by `requireUser` (kept on `res.locals`, Express's per-request store). */
export function principalOf(res: Response): Principal {
  return res.locals.principal as Principal;
}

const unauthorized = { error: { code: 'unauthorized', message: 'Sign in required' } };
const forbidden = { error: { code: 'forbidden', message: 'Admins only' } };

/** Accept only requests carrying a valid access token (`Authorization: Bearer <token>`). */
export function requireUser(secret: string): RequestHandler {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const principal = token ? verifyAccessToken(token, secret) : null;
    if (!principal) {
      res.status(401).json(unauthorized);
      return;
    }
    res.locals.principal = principal;
    next();
  };
}

/** After `requireUser`: accept only admins. */
export const requireAdmin: RequestHandler = (_req, res, next) => {
  if ((res.locals.principal as Principal | undefined)?.role !== 'admin') {
    res.status(403).json(forbidden);
    return;
  }
  next();
};

/** Read one cookie from the request without a cookie-parsing library. */
export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
