import { useEffect, useState } from 'react';
import { AnimatedNumber } from '../components/AnimatedNumber.tsx';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { Orbit } from '../components/Orbit.tsx';
import { useGlobeSnapshots } from '../hooks/snapshots.ts';
import { navigate } from '../router.ts';
import { useAuth } from '../store/auth.ts';
import { useGlobe } from '../store/globe.ts';
import { useLive } from '../store/live.ts';
import { formatInt } from '../theme.ts';

/*
 * The sign-in page. Flat by design: solid surfaces, hairlines, one accent.
 * Few words, one big button, and a live picture of the internet beside it.
 * Things arrive in sequence rather than all at once.
 */

const HEADLINE = ['Put', 'your', 'corner', 'of', 'the', 'internet', 'on', 'watch.'];
const PERKS = ['Your own watchlist', 'Alerts that find you', 'Straight into Discord'];
const LINE = '#1a2432';

/** A beat in the page's entrance: rises into place after `delay` seconds. */
const enter = (delay: number) => ({
  animation: `rise .8s cubic-bezier(.2,.8,.2,1) ${delay}s both`,
});

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

  // Signing in from this page takes you to the globe, where your greeting waits.
  const [wasAnon, setWasAnon] = useState(false);
  useEffect(() => {
    if (status === 'anon') setWasAnon(true);
    if (status === 'signed-in' && wasAnon) navigate('/');
  }, [status, wasAnon]);

  const headlineEnd = 0.25 + HEADLINE.length * 0.07;

  return (
    <main
      className="relative grid min-h-dvh lg:h-dvh lg:grid-cols-2 lg:overflow-hidden"
      style={{ background: '#05070c' }}
    >
      {/* ---- left: the invitation */}
      <section className="flex flex-col justify-center px-[clamp(1.5rem,6vw,8rem)] pt-28 pb-12 lg:pt-16">
        <div
          className="flex items-center gap-3 font-mono text-[0.7rem] tracking-[0.22em] text-low uppercase"
          style={enter(0.1)}
        >
          <span className="size-1.5 bg-signal" />
          Account · optional
        </div>

        <h1 className="mt-6 max-w-[13ch] text-[clamp(2.8rem,5.4vw,6.6rem)] leading-[0.98] font-semibold tracking-[-0.035em] text-hi">
          {HEADLINE.map((word, i) => (
            <span key={i} className="inline-block overflow-hidden pr-[0.24em] align-bottom">
              <span
                className={`inline-block ${word === 'watch.' ? 'text-signal' : ''}`}
                style={{ animation: `word .9s cubic-bezier(.2,.8,.2,1) ${0.25 + i * 0.07}s both` }}
              >
                {word}
              </span>
            </span>
          ))}
        </h1>

        <p
          className="mt-6 max-w-[42ch] text-[clamp(1rem,1.15vw,1.2rem)] leading-relaxed text-mid"
          style={enter(headlineEnd)}
        >
          The globe is open to everyone. Sign in to choose what matters to you, and hear the moment
          it breaks.
        </p>

        <div className="mt-10" style={enter(headlineEnd + 0.15)}>
          {status === 'loading' && <p className="text-sm text-low">Checking for a session…</p>}

          {status === 'anon' &&
            (clientId ? (
              // Google draws this button itself (its maximum is 400 px wide); scaling
              // the container makes it larger without imitating Google's design.
              <div className="w-fit origin-left scale-[1.18]">
                <GoogleButton theme="filled_black" size="large" text="continue_with" width={360} />
              </div>
            ) : (
              <p className="text-sm text-caution">Sign-in is not set up on this server yet.</p>
            ))}

          {status === 'signed-in' && user && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-mid">
                Signed in as <span className="text-hi">{user.name}</span>
              </span>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="rounded-full bg-signal px-5 py-2.5 text-sm font-semibold text-void"
              >
                Open the globe
              </button>
              <button
                type="button"
                onClick={() => navigate('/me')}
                className="rounded-full border px-5 py-2.5 text-sm text-hi"
                style={{ borderColor: LINE }}
              >
                Your watchlist
              </button>
            </div>
          )}
          {error && <p className="mt-4 text-sm text-caution">{error}</p>}

          {status !== 'signed-in' && (
            <button
              type="button"
              onClick={() => navigate('/')}
              className="mt-7 block text-sm text-mid transition hover:text-hi"
            >
              Continue as a visitor →
            </button>
          )}
        </div>

        <ul
          className="mt-14 flex flex-wrap gap-x-8 gap-y-3 border-t pt-6"
          style={{ borderColor: LINE }}
        >
          {PERKS.map((perk, i) => (
            <li
              key={perk}
              className="flex items-baseline gap-2.5 text-sm text-hi"
              style={enter(headlineEnd + 0.4 + i * 0.12)}
            >
              <span className="font-mono text-xs text-signal">0{i + 1}</span>
              {perk}
            </li>
          ))}
        </ul>

        <p
          className="mt-6 max-w-[56ch] text-xs leading-relaxed text-low"
          style={enter(headlineEnd + 0.8)}
        >
          Google shares your name, email address and profile picture with us. There is no password
          to store, and signing out ends the session.
        </p>
      </section>

      {/* ---- right: the internet, live */}
      <section
        className="relative min-h-[60vh] border-t lg:min-h-0 lg:border-t-0 lg:border-l"
        style={{ background: '#070b12', borderColor: LINE, animation: 'fade 1.4s .2s both' }}
      >
        <Orbit />
        <div className="pointer-events-none absolute top-24 right-8 text-right font-mono text-[0.68rem] tracking-[0.16em] text-low uppercase">
          {probes ? `${formatInt(probes)} probes` : ''}
          {countries !== undefined && <div className="mt-1">{countries} countries active</div>}
        </div>
        <div className="pointer-events-none absolute bottom-8 left-8" style={enter(1.1)}>
          <div className="flex items-center gap-2 font-mono text-[0.68rem] tracking-[0.18em] text-low uppercase">
            <span className="size-1.5 animate-[blink_1.6s_ease-in-out_infinite] rounded-full bg-signal" />
            Live · RIPE RIS
          </div>
          <div className="mt-2 font-mono text-[clamp(2.4rem,4vw,4.4rem)] leading-none font-medium text-hi tabular-nums">
            <AnimatedNumber value={ann === undefined ? undefined : ann + (wd ?? 0)} />
          </div>
          <div className="mt-2 text-sm text-mid">route changes in the last second</div>
          <div className="mt-1 text-xs text-low">Each amber arc on the sphere is part of it.</div>
        </div>
      </section>
    </main>
  );
}
