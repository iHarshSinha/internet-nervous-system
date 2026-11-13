import { useEffect, useRef, useState } from 'react';
import { navigate } from '../router.ts';
import { signOut, useAuth } from '../store/auth.ts';
import { useLive } from '../store/live.ts';
import { GoogleButton } from './GoogleButton.tsx';

function Avatar({
  name,
  picture,
  size = 28,
}: {
  name: string;
  picture: string | null;
  size?: number;
}) {
  const initial = name.trim()[0]?.toUpperCase() ?? '?';
  return picture ? (
    <img
      src={picture}
      alt=""
      referrerPolicy="no-referrer"
      className="rounded-full ring-1 ring-white/15"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="grid place-items-center rounded-full bg-signal/15 font-medium text-signal ring-1 ring-signal/30"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initial}
    </span>
  );
}

/**
 * The header's account area. Visitors see Google's sign-in button (only when
 * sign-in is configured); signed-in people see their avatar and a small menu.
 */
export function Account() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const error = useAuth((s) => s.error);
  const channel = useLive((s) => s.userChannel);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  if (status === 'loading') return null;
  if (status === 'anon' || !user) {
    return (
      <div className="relative">
        <GoogleButton />
        {error && (
          <div className="glass absolute top-full right-0 mt-2 w-56 rounded-xl px-3 py-2 text-xs text-caution">
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="glass flex items-center gap-2 rounded-full py-1 pr-3 pl-1 transition hover:ring-1 hover:ring-white/15"
        aria-expanded={open}
      >
        <Avatar name={user.name} picture={user.picture} />
        <span className="hidden text-xs text-hi sm:inline">{user.name.split(' ')[0]}</span>
        {user.role === 'admin' && (
          <span className="rounded-full bg-caution/15 px-1.5 py-px text-[0.6rem] font-medium tracking-wider text-caution uppercase">
            admin
          </span>
        )}
      </button>
      {open && (
        <div className="glass absolute top-full right-0 mt-2 w-64 animate-[rise_.2s_both] rounded-2xl p-2">
          <div className="flex items-center gap-3 px-2 py-2">
            <Avatar name={user.name} picture={user.picture} size={36} />
            <div className="min-w-0">
              <div className="truncate text-sm text-hi">{user.name}</div>
              <div className="truncate text-[0.7rem] text-low">{user.email}</div>
            </div>
          </div>
          <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 text-[0.68rem] text-mid">
            <span
              className={`size-1.5 rounded-full ${channel === 'live' ? 'bg-signal shadow-[0_0_8px_var(--color-signal)]' : 'bg-caution'}`}
            />
            Personal alert channel {channel === 'live' ? 'connected' : channel}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/me');
            }}
            className="w-full rounded-lg px-2 py-2 text-left text-sm text-hi transition hover:bg-white/[0.06]"
          >
            Your watchlist
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="w-full rounded-lg px-2 py-2 text-left text-sm text-mid transition hover:bg-white/[0.06] hover:text-hi"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
