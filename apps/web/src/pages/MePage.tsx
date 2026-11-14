import {
  SEVERITIES,
  watchlistSchema,
  type MeResponse,
  type Severity,
  type Watchlist,
} from '@ins/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { Panel } from '../components/ui.tsx';
import { countryName, loadCountries, type CountryFeature } from '../geo.ts';
import { navigate } from '../router.ts';
import { authFetch, useAuth } from '../store/auth.ts';
import { flag } from '../theme.ts';

const SEVERITY_TEXT: Record<Severity, string> = {
  watch: 'Everything, even small blips',
  warning: 'Warnings and critical incidents',
  critical: 'Only critical incidents',
};

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-white/[0.05] py-1 pr-1.5 pl-3 text-sm text-hi ring-1 ring-white/[0.08]">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="grid size-5 place-items-center rounded-full text-low transition hover:bg-white/10 hover:text-hi"
        aria-label={`Remove ${label}`}
      >
        ✕
      </button>
    </span>
  );
}

function SignInPrompt() {
  const clientId = useAuth((s) => s.googleClientId);
  return (
    <div className="glass mx-auto mt-10 max-w-xl animate-[rise_.6s_both] rounded-3xl p-8 text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-full bg-signal/10 text-2xl ring-1 ring-signal/30">
        ◎
      </div>
      <h1 className="mt-5 font-display text-4xl text-hi">Make the internet yours</h1>
      <p className="mt-3 text-sm leading-relaxed text-mid">
        Everything on this site is open without an account. Sign in to pick the countries and
        networks you care about, and get an alert the moment something on your list breaks: on
        screen wherever you are, and in your Discord if you like.
      </p>
      <div className="mt-6 flex justify-center">
        {clientId ? (
          <GoogleButton />
        ) : (
          <p className="text-sm text-caution">Sign-in is not set up on this server.</p>
        )}
      </div>
    </div>
  );
}

function WatchlistEditor({ initial }: { initial: Watchlist }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Watchlist>(initial);
  const [countries, setCountries] = useState<CountryFeature[]>([]);
  const [query, setQuery] = useState('');
  const [asnInput, setAsnInput] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => void loadCountries().then(setCountries), []);
  useEffect(() => setDraft(initial), [initial]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return countries
      .map((f) => f.properties.cc)
      .filter((cc) => !draft.countries.includes(cc))
      .filter((cc) => cc.toLowerCase() === q || countryName(cc).toLowerCase().includes(q))
      .slice(0, 6);
  }, [query, countries, draft.countries]);

  const valid = watchlistSchema.safeParse(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const addCountry = (cc: string) => {
    setDraft((d) => ({ ...d, countries: [...d.countries, cc] }));
    setQuery('');
  };
  const addAsn = () => {
    const asn = Number(asnInput.replace(/^as/i, '').trim());
    if (Number.isInteger(asn) && asn > 0 && !draft.asns.includes(asn)) {
      setDraft((d) => ({ ...d, asns: [...d.asns, asn] }));
    }
    setAsnInput('');
  };

  async function save() {
    setState('saving');
    const res = await authFetch('/api/me/watchlist', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setMessage(body?.error?.message ?? `Could not save (HTTP ${res.status})`);
      setState('error');
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    setState('saved');
    setTimeout(() => setState('idle'), 2500);
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel
        title="Countries you watch"
        aside={
          <span className="font-mono text-[0.78rem] text-low">{draft.countries.length}/30</span>
        }
      >
        <div className="flex flex-wrap gap-2">
          {draft.countries.length === 0 && (
            <span className="text-sm text-low">None yet. Search below.</span>
          )}
          {draft.countries.map((cc) => (
            <Chip
              key={cc}
              label={`${flag(cc)} ${countryName(cc)}`}
              onRemove={() =>
                setDraft((d) => ({ ...d, countries: d.countries.filter((c) => c !== cc) }))
              }
            />
          ))}
        </div>
        <div className="relative mt-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && suggestions[0]) addCountry(suggestions[0]);
            }}
            placeholder="Add a country: India, Germany, BR…"
            className="w-full rounded-md bg-white/[0.04] px-3 py-2.5 text-sm text-hi ring-1 ring-white/[0.08] outline-none placeholder:text-low focus:ring-signal/40"
          />
          {suggestions.length > 0 && (
            <ul className="glass absolute inset-x-0 top-full z-10 mt-1 rounded-md p-1">
              {suggestions.map((cc) => (
                <li key={cc}>
                  <button
                    type="button"
                    onClick={() => addCountry(cc)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-hi hover:bg-white/[0.06]"
                  >
                    {flag(cc)} {countryName(cc)}{' '}
                    <span className="ml-auto font-mono text-xs text-low">{cc}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel
        title="Networks you watch"
        aside={<span className="font-mono text-[0.78rem] text-low">{draft.asns.length}/30</span>}
      >
        <div className="flex flex-wrap gap-2">
          {draft.asns.length === 0 && (
            <span className="text-sm text-low">
              None yet. A network is identified by its AS number, for example AS13335 (Cloudflare).
            </span>
          )}
          {draft.asns.map((asn) => (
            <Chip
              key={asn}
              label={`AS${asn}`}
              onRemove={() => setDraft((d) => ({ ...d, asns: d.asns.filter((a) => a !== asn) }))}
            />
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <input
            value={asnInput}
            onChange={(e) => setAsnInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addAsn()}
            placeholder="AS32934"
            inputMode="numeric"
            className="min-w-0 flex-1 rounded-md bg-white/[0.04] px-3 py-2.5 font-mono text-sm text-hi ring-1 ring-white/[0.08] outline-none placeholder:text-low focus:ring-signal/40"
          />
          <button
            type="button"
            onClick={addAsn}
            className="rounded-md px-4 text-sm text-signal ring-1 ring-signal/30 transition hover:bg-signal/10"
          >
            Add
          </button>
        </div>
      </Panel>

      <Panel title="Alert me about">
        <div className="grid gap-2">
          {SEVERITIES.map((s) => (
            <label
              key={s}
              className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 ring-1 transition ${
                draft.minSeverity === s
                  ? 'bg-signal/[0.07] ring-signal/30'
                  : 'ring-white/[0.06] hover:bg-white/[0.03]'
              }`}
            >
              <input
                type="radio"
                name="severity"
                checked={draft.minSeverity === s}
                onChange={() => setDraft((d) => ({ ...d, minSeverity: s }))}
                className="accent-[#5ee6ff]"
              />
              <span className="text-sm text-hi capitalize">{s}</span>
              <span className="text-xs text-mid">{SEVERITY_TEXT[s]}</span>
            </label>
          ))}
        </div>
      </Panel>

      <Panel title="Also send to Discord (optional)">
        <input
          value={draft.discordWebhook ?? ''}
          onChange={(e) =>
            setDraft((d) => ({ ...d, discordWebhook: e.target.value.trim() || null }))
          }
          placeholder="https://discord.com/api/webhooks/…"
          className="w-full rounded-md bg-white/[0.04] px-3 py-2.5 font-mono text-xs text-hi ring-1 ring-white/[0.08] outline-none placeholder:text-low focus:ring-signal/40"
        />
        <p className="mt-2 text-xs text-low">
          In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy URL. Only
          Discord webhook addresses are accepted.
        </p>
        {!valid.success && draft.discordWebhook && (
          <p className="mt-2 text-xs text-caution">
            That does not look like a Discord webhook URL.
          </p>
        )}
      </Panel>

      <div className="flex items-center gap-4 lg:col-span-2">
        <button
          type="button"
          disabled={!dirty || !valid.success || state === 'saving'}
          onClick={() => void save()}
          className="rounded-md bg-signal px-6 py-2.5 text-sm font-semibold text-void transition enabled:hover:brightness-110 disabled:opacity-30"
        >
          {state === 'saving' ? 'Saving…' : 'Save watchlist'}
        </button>
        {state === 'saved' && <span className="text-sm text-signal">Saved ✓</span>}
        {state === 'error' && <span className="text-sm text-caution">{message}</span>}
      </div>
    </div>
  );
}

export function MePage() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const me = useQuery({
    queryKey: ['me', user?.id],
    queryFn: async () => {
      const res = await authFetch('/api/me');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as MeResponse;
    },
    enabled: status === 'signed-in',
  });

  return (
    <main className="relative min-h-dvh">
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(90%_60%_at_80%_0%,#1a3558_0%,#0a1321_55%)]" />
      <div className="mx-auto w-full max-w-[1400px] px-4 pt-24 pb-12 sm:px-8 xl:px-12">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mb-5 text-sm text-mid transition hover:text-hi"
        >
          ← Back to the globe
        </button>

        {status === 'loading' && <p className="text-sm text-low">Checking your session…</p>}
        {status === 'anon' && <SignInPrompt />}
        {status === 'signed-in' && user && (
          <div className="animate-[rise_.6s_both]">
            <div className="label">Your account</div>
            <h1 className="mt-1 font-display text-5xl leading-none text-hi sm:text-6xl">
              Your watchlist
            </h1>
            <p className="mt-2 mb-6 max-w-2xl text-sm text-mid">
              When an incident touches a country or network on this list, you get an alert on screen
              wherever you are in the app, delivered through your own private Socket.IO channel.
            </p>
            {me.isPending && <p className="text-sm text-low">Loading…</p>}
            {me.error && <p className="text-sm text-caution">Could not load your watchlist.</p>}
            {me.data && <WatchlistEditor initial={me.data.watchlist} />}
          </div>
        )}
      </div>
    </main>
  );
}
