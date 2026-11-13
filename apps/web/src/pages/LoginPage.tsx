import { useEffect, useRef, useState } from 'react';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { countryName } from '../geo.ts';
import { useGlobeSnapshots } from '../hooks/snapshots.ts';
import { useTick } from '../hooks/tick.ts';
import { navigate } from '../router.ts';
import { useAuth } from '../store/auth.ts';
import { useGlobe } from '../store/globe.ts';
import { useLive } from '../store/live.ts';
import { flag, formatInt } from '../theme.ts';

/*
 * The sign-in page. Deliberately flat: solid surfaces, hairline borders, one
 * accent colour, real numbers instead of decoration. Everything on it is
 * live, so even the login screen shows the product working.
 */

const SURFACE = '#0a0f17';
const LINE = '#1a2432';

const PERKS = [
  {
    title: 'A watchlist that is yours',
    body: 'Pin the countries and networks you care about: your country, your university, your cloud provider.',
  },
  {
    title: 'Alerts that find you',
    body: 'When something on your list breaks, a private Socket.IO channel brings the alert to whatever page you are on.',
  },
  {
    title: 'Straight into Discord',
    body: 'Add a webhook and the same alert lands in your team’s channel, with the evidence attached.',
  },
  {
    title: 'Your own probe, on the map',
    body: 'Register a laptop as a measurement point and watch it report alongside 15,000 RIPE Atlas probes.',
  },
];

/** A live, flat line chart of world route changes per second. No fills, no glow. */
function Pulse() {
  const ref = useRef<SVGPolylineElement>(null);
  useTick(1000);
  const pts = useGlobe.getState().worldSeconds.slice(-60);
  const max = Math.max(1, ...pts.map((p) => p.ann + p.wd));
  const points = pts
    .map((p, i) => `${((i + 60 - pts.length) / 59) * 100},${38 - ((p.ann + p.wd) / max) * 34}`)
    .join(' ');
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="block h-16 w-full">
      {[10, 20, 30].map((y) => (
        <line
          key={y}
          x1="0"
          x2="100"
          y1={y}
          y2={y}
          stroke={LINE}
          strokeWidth="0.4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polyline
        ref={ref}
        points={points}
        fill="none"
        stroke="#5ee6ff"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The five busiest countries this second, as a flat tape with solid bars. */
function Tape() {
  useTick(1000);
  const rows = [...useGlobe.getState().countries]
    .filter(([, c]) => (c.act ?? 0) > 0)
    .sort((a, b) => (b[1].act ?? 0) - (a[1].act ?? 0))
    .slice(0, 5);
  const max = Math.max(1, ...rows.map(([, c]) => c.act ?? 0));
  return (
    <ol className="divide-y" style={{ borderColor: LINE }}>
      {rows.length === 0 && (
        <li className="py-3 font-mono text-xs text-low">waiting for the first second…</li>
      )}
      {rows.map(([cc, c], i) => (
        <li key={cc} className="flex items-center gap-3 py-2" style={{ borderColor: LINE }}>
          <span className="w-4 font-mono text-[0.65rem] text-low">0{i + 1}</span>
          <span className="text-sm leading-none">{flag(cc)}</span>
          <span className="w-28 truncate text-[0.8rem] text-hi">{countryName(cc)}</span>
          <span className="h-1 flex-1 bg-white/[0.04]">
            <span
              className="block h-full bg-signal transition-[width] duration-700"
              style={{ width: `${((c.act ?? 0) / max) * 100}%` }}
            />
          </span>
          <span className="w-12 text-right font-mono text-xs text-mid tabular-nums">
            {formatInt(c.act ?? 0)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Figure({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="border-l pl-4" style={{ borderColor: LINE }}>
      <div className="font-mono text-[0.62rem] tracking-[0.16em] text-low uppercase">{label}</div>
      <div className="mt-1 font-mono text-2xl text-hi tabular-nums">
        {value}
        {unit && <span className="ml-1 text-xs text-mid">{unit}</span>}
      </div>
    </div>
  );
}

export function LoginPage() {
  useGlobeSnapshots(); // probe and country numbers, even when the globe was never opened
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

  const changes = ann === undefined ? '—' : formatInt(ann + (wd ?? 0));

  return (
    <main className="relative min-h-dvh" style={{ background: '#05070c' }}>
      {/* A plain hairline grid, drawn as an SVG pattern. */}
      <svg aria-hidden="true" className="pointer-events-none fixed inset-0 h-full w-full">
        <defs>
          <pattern id="login-grid" width="56" height="56" patternUnits="userSpaceOnUse">
            <path d="M56 0H0V56" fill="none" stroke="#0e151f" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#login-grid)" />
      </svg>

      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 pt-28 pb-16 sm:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:gap-14 lg:pt-32">
        {/* ---- left: the pitch */}
        <section className="animate-[rise_.7s_both]">
          <div className="flex items-center gap-3 font-mono text-[0.68rem] tracking-[0.2em] text-low uppercase">
            <span className="size-1.5 bg-signal" />
            Account · optional
          </div>
          <h1 className="mt-5 max-w-[16ch] text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.03em] text-hi sm:text-6xl">
            Put your corner of the internet on watch.
          </h1>
          <p className="mt-5 max-w-[52ch] text-[0.98rem] leading-relaxed text-mid">
            The globe is open to everyone. An account makes it personal: choose what matters to you,
            and we will tell you the moment it breaks.
          </p>

          <div className="mt-9 grid grid-cols-2 gap-y-6 sm:grid-cols-3">
            <Figure label="Route changes" value={changes} unit="/ s" />
            <Figure label="Probes on the map" value={probes ? formatInt(probes) : '—'} />
            <Figure
              label="Countries active"
              value={countries === undefined ? '—' : String(countries)}
            />
          </div>

          <ol className="mt-12 border-t" style={{ borderColor: LINE }}>
            {PERKS.map((perk, i) => (
              <li
                key={perk.title}
                className="grid grid-cols-[3rem_1fr] gap-x-4 border-b py-5"
                style={{ borderColor: LINE }}
              >
                <span className="font-mono text-sm text-signal">0{i + 1}</span>
                <div>
                  <div className="text-[0.95rem] font-medium text-hi">
                    {perk.title}
                    {i === 3 && (
                      <span
                        className="ml-2 border px-1.5 py-px align-middle font-mono text-[0.6rem] tracking-wider text-low uppercase"
                        style={{ borderColor: LINE }}
                      >
                        soon
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-mid">{perk.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- right: the sign-in card */}
        <section className="animate-[rise_.7s_.12s_both] lg:sticky lg:top-28 lg:self-start">
          <div
            className="rounded-[22px] border p-6 sm:p-7"
            style={{ background: SURFACE, borderColor: LINE }}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-xl font-semibold text-hi">Sign in</h2>
              <span className="font-mono text-[0.65rem] tracking-[0.16em] text-low uppercase">
                with Google
              </span>
            </div>

            <div className="mt-5 rounded-2xl border p-4" style={{ borderColor: LINE }}>
              <div className="flex items-center justify-between font-mono text-[0.62rem] tracking-[0.16em] text-low uppercase">
                <span className="flex items-center gap-2">
                  <span className="size-1.5 animate-[blink_1.6s_ease-in-out_infinite] rounded-full bg-signal" />
                  Live · route changes / s
                </span>
                <span className="text-mid">{changes}</span>
              </div>
              <Pulse />
              <div className="mt-2 font-mono text-[0.62rem] tracking-[0.16em] text-low uppercase">
                Busiest this second
              </div>
              <Tape />
            </div>

            <div className="mt-6">
              {status === 'loading' && <p className="text-sm text-low">Checking for a session…</p>}

              {status === 'signed-in' && user && (
                <div>
                  <p className="text-sm text-mid">
                    You are signed in as <span className="text-hi">{user.name}</span>.
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => navigate('/')}
                      className="rounded-full bg-signal py-2.5 text-sm font-semibold text-void"
                    >
                      Open the globe
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate('/me')}
                      className="rounded-full border py-2.5 text-sm text-hi"
                      style={{ borderColor: LINE }}
                    >
                      Your watchlist
                    </button>
                  </div>
                </div>
              )}

              {status === 'anon' &&
                (clientId ? (
                  <div className="flex justify-center">
                    <GoogleButton
                      theme="filled_black"
                      size="large"
                      text="continue_with"
                      width={320}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-caution">Sign-in is not set up on this server yet.</p>
                ))}
              {error && <p className="mt-3 text-center text-sm text-caution">{error}</p>}
            </div>

            <dl
              className="mt-6 space-y-2 border-t pt-5 text-[0.78rem] text-mid"
              style={{ borderColor: LINE }}
            >
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 font-mono text-[0.65rem] tracking-[0.12em] text-low uppercase">
                  We get
                </dt>
                <dd>Your name, email address and profile picture, from Google.</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 font-mono text-[0.65rem] tracking-[0.12em] text-low uppercase">
                  Never
                </dt>
                <dd>Your password. We do not have one to store.</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 font-mono text-[0.65rem] tracking-[0.12em] text-low uppercase">
                  Session
                </dt>
                <dd>15-minute keys that renew quietly for up to 7 days. Sign out ends it.</dd>
              </div>
            </dl>
          </div>

          <button
            type="button"
            onClick={() => navigate('/')}
            className="mt-5 w-full text-center text-sm text-mid transition hover:text-hi"
          >
            Continue as a visitor →
          </button>
        </section>
      </div>
    </main>
  );
}
