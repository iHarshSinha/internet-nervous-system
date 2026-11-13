import { useEffect, useRef } from 'react';
import { signInWithGoogle, useAuth } from '../store/auth.ts';

/** Google Identity Services, loaded from Google only when sign-in is configured. */
interface GoogleIdentity {
  accounts: {
    id: {
      initialize(options: {
        client_id: string;
        callback: (response: { credential: string }) => void;
        auto_select?: boolean;
        ux_mode?: 'popup' | 'redirect';
      }): void;
      renderButton(
        element: HTMLElement,
        options: {
          theme?: string;
          size?: string;
          shape?: string;
          text?: string;
          logo_alignment?: string;
          width?: number;
        },
      ): void;
      disableAutoSelect(): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

let script: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  script ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://accounts.google.com/gsi/client';
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Could not load Google sign-in'));
    document.head.appendChild(el);
  });
  return script;
}

/**
 * Google's own "Sign in with Google" button. Google hands the page a signed ID
 * token; we send it to our server, which checks it and starts our session.
 * The page never sees a password.
 */
export function GoogleButton({
  theme = 'filled_black',
  size = 'medium',
  text = 'signin',
  width,
}: {
  theme?: 'filled_black' | 'outline' | 'filled_blue';
  size?: 'small' | 'medium' | 'large';
  text?: 'signin' | 'signin_with' | 'continue_with';
  width?: number;
} = {}) {
  const clientId = useAuth((s) => s.googleClientId);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void loadGoogleScript().then(() => {
      const google = window.google;
      if (cancelled || !google || !box.current) return;
      google.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => void signInWithGoogle(credential),
        auto_select: false,
        ux_mode: 'popup',
      });
      google.accounts.id.renderButton(box.current, {
        theme,
        size,
        shape: 'pill',
        text,
        logo_alignment: 'left',
        ...(width && { width }),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [clientId, theme, size, text, width]);

  if (!clientId) return null;
  return <div ref={box} className="min-h-8" />;
}
