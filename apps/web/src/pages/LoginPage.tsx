import { useEffect, useState } from 'react';
import { AnimatedNumber } from '../components/AnimatedNumber.tsx';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { WorldDots } from '../components/WorldDots.tsx';
import { useGlobeSnapshots } from '../hooks/snapshots.ts';
import { navigate } from '../router.ts';
import { useAuth } from '../store/auth.ts';
import { useGlobe } from '../store/globe.ts';
import { activeIncidents, useIncidents } from '../store/incidents.ts';
import { useLive } from '../store/live.ts';

/*
 * The sign-in page. Flat by design: one ink sheet, hairlines, a serif
 * headline, one big button, and the live world drifting past beside it.
 * Things arrive in sequence rather than all at once.
 */

/** The headline, word by word; the accent words are set in italic and in the signal colour. */
const HEADLINE = ['Keep', 'watch', 'over', 'your', 'corner', 'of', 'the', 'internet.'];
const ACCENT = new Set(['your', 'corner']);
const PERKS = [
  ['A watchlist', 'of the countries and networks you care about'],
  ['Alerts', 'on your screen the moment one of them breaks'],
];

/** A beat in the page's entrance: rises into place after `delay` seconds. */
const enter = (delay: number) => ({
  animation: `rise .8s cubic-bezier(.2,.8,.2,1) ${delay}s both`,
});

/** One live figure under the map. */
function Figure({
  value,
  label,
  delay,
}: {
  value: number | undefined;
  label: string;
  delay: number;
}) {
  return (
    <div style={enter(delay)}>
      <div className="font-mono text-[clamp(1.6rem,2.4vw,2.6rem)] leading-none font-medium text-hi tabular-nums">
        <AnimatedNumber value={value} />
      </div>
      <div className="mt-2 text-sm text-mid">{label}</div>
    </div>
  );
}

export function LoginPage() {
  useGlobeSnapshots();
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const clientId = useAuth((s) => s.googleClientId);
  const error = useAuth((s) => s.error);
  const ann = useLive((s) => s.world.ann);
  const wd = useLive((s) => s.world.wd);
  const countries = useLive((s) => s.world.countries);
  const probes = useGlobe((s) => s.probePos.size);
  const incidents = useIncidents((s) => activeIncidents(s.byId).length);

  // Signing in from this page takes you to the globe, where your greeting waits.
  const [wasAnon, setWasAnon] = useState(false);
  useEffect(() => {
    if (status === 'anon') setWasAnon(true);
    if (status === 'signed-in' && wasAnon) navigate('/');
  }, [status, wasAnon]);

  const headlineEnd = 0.3 + HEADLINE.length * 0.08;

  return (
    <main className="relative grid min-h-dvh bg-void lg:h-dvh lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
      {/* ---- left: the invitation */}
      <section className="flex min-h-0 flex-col justify-center px-[clamp(1.5rem,5.5vw,7rem)] pt-28 pb-12 lg:pt-24 lg:pb-8">
        <div className="flex items-center gap-3 text-sm text-mid" style={enter(0.1)}>
          <span className="h-px w-8 bg-signal" />
          Sign in · optional
        </div>

        <h1 className="mt-[clamp(1rem,2.5vh,1.75rem)] max-w-[13ch] font-display text-[clamp(3rem,min(5.4vw,10.5vh),7rem)] leading-[0.95] tracking-[-0.01em] text-hi">
          {HEADLINE.map((word, i) => (
            <span
              key={i}
              className="inline-block overflow-hidden pr-[0.22em] pb-[0.08em] align-bottom"
            >
              <span
                className={`inline-block ${ACCENT.has(word) ? 'text-signal italic' : ''}`}
                style={{ animation: `word 1s cubic-bezier(.2,.8,.2,1) ${0.3 + i * 0.08}s both` }}
              >
                {word}
              </span>
            </span>
          ))}
        </h1>

        <p
          className="mt-[clamp(1rem,2.5vh,1.75rem)] max-w-[38ch] text-[clamp(1.1rem,1.3vw,1.35rem)] leading-relaxed text-mid"
          style={enter(headlineEnd)}
        >
          The globe is open to everyone. Sign in to choose what matters to you, and hear the moment
          it breaks.
        </p>

        <div className="mt-[clamp(1.25rem,4vh,2.5rem)]" style={enter(headlineEnd + 0.15)}>
          {status === 'loading' && <p className="text-mid">Checking for a session…</p>}

          {status === 'anon' &&
            (clientId ? (
              // Google draws this button itself (its maximum is 400 px wide); scaling
              // the container makes it larger without imitating Google's design.
              <div className="w-fit origin-left scale-[1.3] pb-3">
                <GoogleButton theme="filled_black" size="large" text="continue_with" width={340} />
              </div>
            ) : (
              <p className="text-caution">Sign-in is not set up on this server yet.</p>
            ))}

          {status === 'signed-in' && user && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg text-mid">
                Signed in as <span className="text-hi">{user.name}</span>
              </span>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="rounded-md bg-signal px-5 py-2.5 font-semibold text-void transition hover:brightness-110"
              >
                Open the globe
              </button>
              <button
                type="button"
                onClick={() => navigate('/me')}
                className="rounded-md border border-line px-5 py-2.5 text-hi transition hover:border-signal/50"
              >
                Your watchlist
              </button>
            </div>
          )}
          {error && <p className="mt-4 text-caution">{error}</p>}

          {status !== 'signed-in' && (
            <button
              type="button"
              onClick={() => navigate('/')}
              className="group mt-[clamp(1rem,3vh,1.75rem)] flex items-center gap-2 text-base text-mid transition hover:text-hi"
            >
              Continue as a visitor
              <span className="transition-transform duration-300 group-hover:translate-x-1.5">
                →
              </span>
            </button>
          )}
        </div>

        <ul className="mt-[clamp(1.25rem,4.5vh,3rem)] grid max-w-[34rem] gap-4 border-t border-line pt-[clamp(1rem,3vh,1.75rem)] sm:grid-cols-2">
          {PERKS.map(([head, rest], i) => (
            <li key={head} style={enter(headlineEnd + 0.4 + i * 0.12)}>
              <div className="font-display text-2xl text-hi">{head}</div>
              <div className="mt-1 text-[0.95rem] leading-snug text-mid">{rest}</div>
            </li>
          ))}
        </ul>

        <p
          className="mt-[clamp(0.75rem,2.5vh,1.75rem)] max-w-[52ch] text-sm leading-relaxed text-low"
          style={enter(headlineEnd + 0.75)}
        >
          Google shares your name, email address and profile picture with us. There is no password
          to store, and signing out ends the session.
        </p>
      </section>

      {/* ---- right: the internet, live */}
      <section className="relative min-h-[70vh] min-w-0 overflow-hidden border-t border-line bg-deep lg:min-h-0 lg:border-t-0 lg:border-l">
        <WorldDots />

        <div
          className="pointer-events-none absolute top-24 left-[clamp(1.25rem,3vw,3rem)] flex items-center gap-2.5 text-sm text-mid"
          style={enter(0.9)}
        >
          <span className="size-2 animate-[blink_1.6s_ease-in-out_infinite] rounded-full bg-signal" />
          The internet, right now
        </div>

        <div className="pointer-events-none absolute inset-x-[clamp(1.25rem,3vw,3rem)] bottom-[clamp(1.5rem,4vh,3rem)]">
          <div className="grid grid-cols-2 gap-x-8 gap-y-6 border-t border-line pt-6 sm:grid-cols-4">
            <Figure
              value={ann === undefined ? undefined : ann + (wd ?? 0)}
              label="route changes this second"
              delay={1.0}
            />
            <Figure value={countries} label="countries active" delay={1.1} />
            <Figure value={probes || undefined} label="probes measuring" delay={1.2} />
            <Figure value={incidents} label="incidents open" delay={1.3} />
          </div>
          <p className="mt-5 text-sm text-low" style={enter(1.5)}>
            Lit dots are countries whose routes are changing now. Arcs are attack traffic seen by
            Cloudflare.
          </p>
        </div>
      </section>
    </main>
  );
}
