import { EMPTY_WATCHLIST, type MeResponse, type Watchlist } from '@ins/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { navigate } from '../router.ts';
import { authFetch, useAuth } from '../store/auth.ts';

/**
 * Add or remove a country from the signed-in user's watchlist, right from its
 * page. Visitors get a nudge to sign in instead.
 */
export function WatchButton({ cc }: { cc: string }) {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
  if (status !== 'signed-in') {
    return (
      <button
        type="button"
        onClick={() => navigate('/login')}
        className="rounded-full border border-white/10 bg-[#0a0f17] px-3.5 py-1.5 text-xs text-mid transition hover:border-signal/40 hover:text-hi"
      >
        ☆ Sign in to watch
      </button>
    );
  }

  const watchlist: Watchlist = me.data?.watchlist ?? EMPTY_WATCHLIST;
  const watching = watchlist.countries.includes(cc);

  async function toggle() {
    const next: Watchlist = {
      ...watchlist,
      countries: watching
        ? watchlist.countries.filter((c) => c !== cc)
        : [...watchlist.countries, cc],
    };
    if (next.countries.length > 30) {
      setProblem('Your watchlist is full (30 countries).');
      return;
    }
    setBusy(true);
    setProblem(null);
    // Show the change at once; put it back if the server says no.
    const key = ['me', user?.id];
    const before = queryClient.getQueryData<MeResponse>(key);
    if (before) queryClient.setQueryData<MeResponse>(key, { ...before, watchlist: next });
    const res = await authFetch('/api/me/watchlist', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!res.ok) {
      if (before) queryClient.setQueryData(key, before);
      setProblem('Could not update your watchlist.');
    }
    setBusy(false);
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={busy || me.isPending}
        onClick={() => void toggle()}
        className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
          watching
            ? 'bg-signal text-void hover:brightness-110'
            : 'border border-signal/40 text-signal hover:bg-signal/10'
        }`}
      >
        {watching ? '★ On your watchlist' : '☆ Add to watchlist'}
      </button>
      {problem && <span className="text-xs text-caution">{problem}</span>}
    </div>
  );
}
