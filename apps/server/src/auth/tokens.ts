import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@ins/shared';
import jwt from 'jsonwebtoken';

/** Access tokens live 15 minutes; refresh tokens 7 days (and are replaced on every use). */
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_MS = 7 * 24 * 3600_000;

/** What an access token says about its holder. */
export interface Principal {
  id: string;
  role: Role;
  email: string;
}

export function signAccessToken(
  p: Principal,
  secret: string,
): { token: string; expiresAt: number } {
  const token = jwt.sign({ role: p.role, email: p.email }, secret, {
    algorithm: 'HS256',
    subject: p.id,
    expiresIn: ACCESS_TTL_S,
    issuer: 'ins',
  });
  return { token, expiresAt: Date.now() + ACCESS_TTL_S * 1000 };
}

/** Returns the principal, or null for a missing, forged or expired token. */
export function verifyAccessToken(token: string, secret: string): Principal | null {
  try {
    const p = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'ins' }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || (p.role !== 'user' && p.role !== 'admin')) return null;
    return { id: p.sub, role: p.role, email: String(p.email ?? '') };
  } catch {
    return null;
  }
}

/** A new refresh token: 32 random bytes. Only its hash is ever stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
