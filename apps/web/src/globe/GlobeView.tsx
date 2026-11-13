import { useEffect, useMemo, useRef, useState } from 'react';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import { MeshPhongMaterial, type Object3D, type PerspectiveCamera } from 'three';
import { countryInfo, countryName, loadCountries, type CountryFeature } from '../geo.ts';
import { useGlobe } from '../store/globe.ts';
import { selectCountry, useUi } from '../store/ui.ts';
import { BUCKET_COLORS, formatInt, healthColor } from '../theme.ts';

/** How often the globe re-reads live data. Its own animation still runs at full frame rate. */
const REFRESH_MS = 1200;
const PULSING_COUNTRIES = 14;
export const GLOBE_HOME = { lat: 22, lng: 18, altitude: 2.25 };

interface ProbeSet {
  color: string;
  size: number;
  pts: { lat: number; lng: number }[];
}

interface Ring {
  lat: number;
  lng: number;
  r: number;
}

const material = new MeshPhongMaterial({ color: '#08121d', emissive: '#02070e', shininess: 6 });

const ccOf = (f: object | null | undefined): string | null =>
  (f as CountryFeature | undefined)?.properties?.cc ?? null;

function tooltip(cc: string | null): string {
  if (!cc) return '';
  const c = useGlobe.getState().countries.get(cc);
  const row = (k: string, v: string) =>
    `<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:#8ea3b5">${k}</span><span style="font-family:ui-monospace,monospace">${v}</span></div>`;
  return `<div style="background:rgba(8,13,22,.92);border:1px solid rgba(94,230,255,.18);border-radius:12px;padding:10px 12px;min-width:200px;color:#e8f1f8;font:13px system-ui;box-shadow:0 12px 40px -12px #000">
    <div style="font-weight:600;margin-bottom:6px">${countryName(cc)}</div>
    ${row('Health', c?.h === undefined ? '—' : `${c.h} / 100`)}
    ${row('Route changes', c?.act === undefined ? '—' : `${formatInt(c.act)} / s`)}
    ${row('Median latency', typeof c?.p50 === 'number' ? `${c.p50} ms` : '—')}
    <div style="margin-top:6px;color:#55677a;font-size:11px">Click for details</div>
  </div>`;
}

/**
 * The hero: a dark globe whose land is a field of dots coloured by each
 * country's network health, with every RIPE Atlas probe as a point of light
 * coloured by its latency, and ripples where routing is busiest right now.
 */
export function GlobeView() {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  const reticleRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [features, setFeatures] = useState<CountryFeature[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const selected = useUi((s) => s.selected);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    void loadCountries().then(setFeatures);
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setSize({ w: box.clientWidth, h: box.clientHeight });
    measure(); // at once, so the globe does not wait for the first observer callback
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // Re-read the live data on a fixed rhythm, and only if it changed.
  useEffect(() => {
    let seen = -1;
    const timer = setInterval(() => {
      const v = useGlobe.getState().version;
      if (v !== seen) {
        seen = v;
        setFrame((f) => f + 1);
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  /*
   * Self-healing. If any code throws inside the globe library's render loop,
   * the loop stops scheduling frames and the globe freezes (no drawing, no
   * zoom, no clicks) until a reload. That happened once: a tooltip asked for
   * a probe that a data refresh had just replaced. That cause is fixed below,
   * and this watchdog restarts the loop should anything similar ever happen.
   */
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const globe = globeRef.current;
      if (!globe || !String(e.error?.stack ?? '').includes('animationCycle')) return;
      globe.pauseAnimation();
      globe.resumeAnimation();
    };
    window.addEventListener('error', onError);
    return () => window.removeEventListener('error', onError);
  }, []);

  // Fly the camera on request (region buttons, selecting a country).
  useEffect(
    () =>
      useUi.subscribe((state, prev) => {
        const globe = globeRef.current;
        if (!globe) return;
        if (state.fly && state.fly !== prev.fly) {
          globe.controls().autoRotate = false;
          globe.pointOfView(state.fly, 1600);
        }
        if (state.selected && state.selected !== prev.selected) {
          const info = countryInfo(state.selected);
          globe.controls().autoRotate = false;
          if (info) globe.pointOfView({ lat: info.lat, lng: info.lng, altitude: 1.7 }, 1400);
        }
      }),
    [],
  );

  // Keep the decorative scope ring hugging the globe's silhouette, whatever the zoom.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const globe = globeRef.current;
      const ring = reticleRef.current;
      if (!globe || !ring || size.h === 0) return;
      const camera = globe.camera() as PerspectiveCamera;
      const distance = camera.position.length();
      const radius = 100; // three-globe's globe radius in scene units
      if (distance <= radius) return;
      const angular = Math.asin(radius / distance);
      const px = (size.h / 2) * (Math.tan(angular) / Math.tan(((camera.fov / 2) * Math.PI) / 180));
      ring.style.setProperty('--r', `${Math.round(px)}px`);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [size.h]);

  // Release the GPU context when the globe leaves the page.
  useEffect(
    () => () => {
      const renderer = globeRef.current?.renderer();
      renderer?.dispose();
      renderer?.forceContextLoss();
    },
    [],
  );

  const { probeSets, rings, colorOf } = useMemo(() => {
    const { countries, probePos, probeBucket } = useGlobe.getState();

    const sets: ProbeSet[] = BUCKET_COLORS.map((color) => ({ color, size: 2.2, pts: [] }));
    const unknown: ProbeSet = { color: 'rgba(120,150,180,0.35)', size: 1.4, pts: [] };
    for (const [id, [lat, lng]] of probePos) {
      const b = probeBucket.get(id);
      (b === undefined ? unknown : (sets[b] ?? unknown)).pts.push({ lat, lng });
    }

    const ringList: Ring[] = [];
    const busiest = [...countries]
      .filter(([, c]) => (c.act ?? 0) > 0)
      .sort((a, b) => (b[1].act ?? 0) - (a[1].act ?? 0))
      .slice(0, PULSING_COUNTRIES);
    for (const [cc, c] of busiest) {
      const label = countryInfo(cc);
      if (label) {
        ringList.push({
          lat: label.lat,
          lng: label.lng,
          r: 1.2 + Math.log10((c.act ?? 0) + 1) * 1.6,
        });
      }
    }

    const colors = new Map<string, string>();
    for (const f of features) {
      const cc = f.properties.cc;
      colors.set(
        cc,
        cc === selected
          ? '#ffffff'
          : cc === hovered
            ? '#cfe9f7'
            : healthColor(countries.get(cc)?.h, 0.92),
      );
    }
    return {
      probeSets: [unknown, ...sets],
      rings: ringList,
      colorOf: (f: object) => colors.get(ccOf(f) ?? '') ?? '#1d2a3a',
    };
    // `frame` is the trigger: the data lives in the mutable store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, features, hovered, selected]);

  function onReady() {
    const globe = globeRef.current;
    if (!globe) return;
    // Fly in from far away, then drift.
    globe.pointOfView({ lat: 24, lng: 12, altitude: 4.2 }, 0);
    globe.pointOfView(GLOBE_HOME, 2600);
    const controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.enableDamping = true;
    controls.minDistance = 130;
    controls.maxDistance = 650;
    let resume: ReturnType<typeof setTimeout> | undefined;
    controls.addEventListener('start', () => {
      controls.autoRotate = false;
      clearTimeout(resume);
    });
    controls.addEventListener('end', () => {
      resume = setTimeout(() => {
        if (!useUi.getState().selected) controls.autoRotate = true;
      }, 12_000);
    });
  }

  return (
    <div ref={boxRef} className="absolute inset-0">
      {/* A slowly turning scope ring that hugs the globe's edge. */}
      <div
        ref={reticleRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 hidden sm:block"
      >
        <div className="reticle" />
      </div>
      {size.w > 0 && (
        <Globe
          ref={globeRef}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          globeMaterial={material}
          showAtmosphere
          atmosphereColor="#3fc8ff"
          atmosphereAltitude={0.17}
          onGlobeReady={onReady}
          onGlobeClick={() => selectCountry(null)}
          // Only the land is interactive. Hit-testing 15,000 probe dots on every
          // mouse move is wasted work, and their tooltips caused the freeze.
          pointerEventsFilter={(obj: Object3D) => !(obj as { isPoints?: boolean }).isPoints}
          hexPolygonsData={features}
          hexPolygonResolution={3}
          hexPolygonMargin={0.42}
          hexPolygonUseDots
          hexPolygonAltitude={0.006}
          hexPolygonColor={colorOf}
          hexPolygonsTransitionDuration={0}
          hexPolygonLabel={(f: object) => tooltip(ccOf(f))}
          onHexPolygonHover={(f: object | null) => setHovered(ccOf(f))}
          onHexPolygonClick={(f: object) => selectCountry(ccOf(f))}
          particlesData={probeSets}
          particlesList="pts"
          particleLat="lat"
          particleLng="lng"
          particleAltitude={0.012}
          particlesColor="color"
          particlesSize="size"
          particlesSizeAttenuation={false}
          particleLabel={() => ''}
          ringsData={rings}
          ringLat="lat"
          ringLng="lng"
          ringAltitude={0.008}
          ringMaxRadius="r"
          ringColor={() => (t: number) => `rgba(94, 230, 255, ${(1 - t) * 0.85})`}
          ringPropagationSpeed={2.2}
          ringRepeatPeriod={1100}
        />
      )}
    </div>
  );
}
