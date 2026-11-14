import type { MeResponse } from '@ins/shared';
import { useQuery } from '@tanstack/react-query';
import { countryName } from '../geo.ts';
import { useTick } from '../hooks/tick.ts';
import { navigate } from '../router.ts';
import { authFetch, useAuth } from '../store/auth.ts';
import { useGlobe } from '../store/globe.ts';
import { flag, healthColor } from '../theme.ts';

function partOfDay(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Top of the globe page. Signed in: a greeting and how the user's watched
 * countries look right now. Visitor: a quiet invitation to sign in.
 */
export function Welcome() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  useTick(2000);
  const me = useQuery({
    queryKey: ['me', user?.id],
    queryFn: async () => {
      const res = await authFetch('/api/me');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as MeResponse;
    },
    enabled: status === 'signed-in',
  });

  if (status === 'loading') return null;

  if (status === 'anon' || !user) {
    return (
      <button
        type="button"
        onClick={() => navigate('/login')}
        className="pointer-events-auto flex animate-[rise_.6s_both] items-center gap-3 rounded-full border border-white/10 bg-[#0a0f17]/95 py-1.5 pr-4 pl-1.5 text-left text-xs text-mid transition hover:border-signal/40 hover:text-hi"
      >
        <span className="shrink-0 rounded-full bg-signal px-2.5 py-1 text-[0.68rem] font-semibold whitespace-nowrap text-void">
          Sign in
        </span>
        Watch your own countries and get alerts when they break →
      </button>
    );
  }

  const first = user.name.split(' ')[0] ?? user.name;
  const watched = me.data?.watchlist.countries ?? [];
  const { countries } = useGlobe.getState();

  return (
    <div className="pointer-events-auto animate-[rise_.6s_both] rounded-2xl border border-white/[0.08] bg-[#0a0f17]/95 px-4 py-3 text-center">
      <div className="text-[0.95rem] text-hi">
        {partOfDay()}, <span className="font-semibold">{first}</span>.
        {user.role === 'admin' && (
          <span className="ml-2 rounded border border-caution/40 px-1.5 py-px align-middle font-mono text-[0.58rem] tracking-wider text-caution uppercase">
            admin
          </span>
        )}
      </div>
      {me.data && watched.length === 0 && (
        <button
          type="button"
          onClick={() => navigate('/me')}
          className="mt-1 text-xs text-signal hover:underline"
        >
          Your watchlist is empty. Pick the countries you care about →
        </button>
      )}
      {watched.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          {watched.slice(0, 5).map((cc) => {
            const h = countries.get(cc)?.h;
            return (
              <button
                key={cc}
                type="button"
                onClick={() => navigate(`/c/${cc}`)}
                className="flex items-center gap-1.5 rounded-full border border-white/[0.08] px-2.5 py-1 text-xs text-hi transition hover:border-white/20"
                title={`${countryName(cc)}: health ${h ?? 'unknown'}`}
              >
                {flag(cc)} {countryName(cc)}
                <span className="font-mono tabular-nums" style={{ color: healthColor(h) }}>
                  {h ?? '—'}
                </span>
              </button>
            );
          })}
          {watched.length > 5 && (
            <span className="text-xs text-low">+{watched.length - 5} more</span>
          )}
        </div>
      )}
    </div>
  );
}
