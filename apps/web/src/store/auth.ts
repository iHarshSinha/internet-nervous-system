import type { AuthConfig, PublicUser, SessionResponse } from '@ins/shared';
import { create } from 'zustand';

interface AuthState {
  /** `loading` until we know whether a session exists. */
  status: 'loading' | 'anon' | 'signed-in';
  user: PublicUser | null;
  /** Kept in memory only, never in localStorage, so page scripts cannot leak it later. */
  accessToken: string | null;
  /** Null when the server has no Google client configured: sign-in is hidden. */
  googleClientId: string | null;
  error: string | null;
}

export const useAuth = create<AuthState>(() => ({
  status: 'loading',
  user: null,
  accessToken: null,
  googleClientId: null,
  error: null,
}));

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<boolean> | null = null;

function adopt(session: SessionResponse): void {
  useAuth.setState({
    status: 'signed-in',
    user: session.user,
    accessToken: session.accessToken,
    error: null,
  });
  // Renew a minute before the 15-minute access token runs out.
  clearTimeout(refreshTimer);
  const inMs = Math.max(10_000, session.expiresAt - Date.now() - 60_000);
  refreshTimer = setTimeout(() => void refresh(), inMs);
}

function forget(): void {
  clearTimeout(refreshTimer);
  useAuth.setState({ status: 'anon', user: null, accessToken: null });
}

/** Swap the httpOnly refresh cookie for a new session. Concurrent callers share one request. */
export function refresh(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (res) => {
      // 204: a visitor with no session. 401: the session ended.
      if (res.status === 204 || !res.ok) {
        forget();
        return false;
      }
      adopt((await res.json()) as SessionResponse);
      return true;
    })
    .catch(() => {
      forget();
      return false;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** On page load: is sign-in available, and is there already a session? */
export async function initAuth(): Promise<void> {
  try {
    const config = (await (await fetch('/api/auth/config')).json()) as AuthConfig;
    useAuth.setState({ googleClientId: config.googleClientId });
  } catch {
    useAuth.setState({ googleClientId: null });
  }
  await refresh();
}

/** Google's button hands us an ID token; the server checks it and starts a session. */
export async function signInWithGoogle(credential: string): Promise<void> {
  const res = await fetch('/api/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    useAuth.setState({ error: body?.error?.message ?? 'Sign-in failed' });
    return;
  }
  adopt((await res.json()) as SessionResponse);
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.google?.accounts.id.disableAutoSelect();
  forget();
}

/** fetch() with the access token; on 401 it refreshes the session once and retries. */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${useAuth.getState().accessToken ?? ''}` },
    });
  const res = await send();
  if (res.status !== 401 || !(await refresh())) return res;
  return send();
}
