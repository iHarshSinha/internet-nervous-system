import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';

/** What we take from a verified Google ID token. */
export interface GoogleIdentity {
  /** Google's stable, unique account ID. */
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity>;

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS: [string, string] = ['accounts.google.com', 'https://accounts.google.com'];

export class GoogleTokenError extends Error {}

/**
 * Check a "Sign in with Google" ID token ourselves, without Google's SDK.
 *
 * The token is a JWT signed by Google. We fetch Google's public keys (a JWKS,
 * cached as long as Google says), pick the key named in the token's header,
 * and let jsonwebtoken check the signature, the expiry, that it was issued by
 * Google and that it was issued FOR OUR APP (audience = our client ID). Only
 * then do we trust the email in it, and only if Google has verified it.
 */
export function createGoogleVerifier(
  clientId: string,
  fetchFn: typeof fetch = fetch,
  certsUrl = GOOGLE_CERTS_URL,
): GoogleVerifier {
  let keys = new Map<string, KeyObject>();
  let expires = 0;

  async function keyFor(kid: string): Promise<KeyObject> {
    if (Date.now() > expires || !keys.has(kid)) {
      const res = await fetchFn(certsUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Google certs: HTTP ${res.status}`);
      const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
      keys = new Map(body.keys.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
      const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
      expires = Date.now() + (maxAge ? Number(maxAge) * 1000 : 3600_000);
    }
    const key = keys.get(kid);
    if (!key) throw new GoogleTokenError('unknown signing key');
    return key;
  }

  return async (credential) => {
    const decoded = jwt.decode(credential, { complete: true });
    const kid = decoded?.header.kid;
    if (!kid) throw new GoogleTokenError('not a signed ID token');

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(credential, await keyFor(kid), {
        algorithms: ['RS256'],
        audience: clientId,
        issuer: ISSUERS,
      }) as jwt.JwtPayload;
    } catch (err) {
      if (err instanceof GoogleTokenError) throw err;
      throw new GoogleTokenError(err instanceof Error ? err.message : 'invalid token');
    }

    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new GoogleTokenError('token has no account or email');
    }
    if (payload.email_verified !== true) throw new GoogleTokenError('email not verified by Google');
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      name: typeof payload.name === 'string' ? payload.name : payload.email,
      picture: typeof payload.picture === 'string' ? payload.picture : null,
    };
  };
}
