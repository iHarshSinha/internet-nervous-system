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
      <section className="glass animate-[rise_.6s_both] rounded-lg p-4">
        <h2 className="title">Make it yours</h2>
        <p className="mt-2 text-[0.98rem] leading-snug text-mid">
          Sign in to watch the countries and networks you care about, and get an alert when one of
          them breaks.
        </p>
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="mt-3 w-full rounded-md bg-hi py-2 text-[0.98rem] font-semibold text-void transition hover:bg-white"
        >
          Sign in
        </button>
      </section>
    );
  }

  const first = user.name.split(' ')[0] ?? user.name;
  const watched = me.data?.watchlist.countries ?? [];
  const { countries } = useGlobe.getState();

  return (
    <section className="glass animate-[rise_.6s_both] rounded-lg p-4">
      <div className="text-[1.15rem] text-hi">
        {partOfDay()}, <span className="font-semibold">{first}</span>.
        {user.role === 'admin' && (
          <span className="ml-2 rounded border border-caution/40 px-1.5 py-px align-middle font-mono text-[0.72rem] tracking-wider text-caution uppercase">
            admin
          </span>
        )}
      </div>
      {me.data && watched.length === 0 && (
        <button
          type="button"
          onClick={() => navigate('/me')}
          className="mt-1.5 text-left text-[0.92rem] text-signal hover:underline"
        >
          Your watchlist is empty. Pick the countries you care about →
        </button>
      )}
      {watched.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => navigate('/me')}
            className="group mt-3 flex w-full items-center justify-between text-[0.9rem] text-low transition hover:text-hi"
          >
            <span>
              Your watchlist <span className="text-low">· {watched.length}</span>
            </span>
            <span className="transition-transform duration-300 group-hover:translate-x-1">
              Edit →
            </span>
          </button>
          {/* Two rows at most: the rest is one click away. */}
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {watched.slice(0, watched.length > 4 ? 3 : 4).map((cc) => {
              const h = countries.get(cc)?.h;
              return (
                <button
                  key={cc}
                  type="button"
                  onClick={() => navigate(`/c/${cc}`)}
                  className="flex min-w-0 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[0.9rem] text-hi transition hover:border-white/25"
                  title={`${countryName(cc)}: health ${h ?? 'unknown'}`}
                >
                  <span>{flag(cc)}</span>
                  <span className="min-w-0 flex-1 truncate text-left">{countryName(cc)}</span>
                  <span className="font-mono tabular-nums" style={{ color: healthColor(h) }}>
                    {h ?? '—'}
                  </span>
                </button>
              );
            })}
            {watched.length > 4 && (
              <button
                type="button"
                onClick={() => navigate('/me')}
                className="rounded-md border border-dashed border-line px-2 py-1 text-[0.9rem] text-mid transition hover:border-white/25 hover:text-hi"
              >
                +{watched.length - 3} more
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
