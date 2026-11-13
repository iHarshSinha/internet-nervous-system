import { useEffect, useMemo, useRef, useState } from 'react';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import { MeshPhongMaterial } from 'three';
import { countryName, loadCountries, type CountryFeature } from '../geo.ts';
import { useGlobe } from '../store/globe.ts';
import { BUCKET_COLORS, formatInt, healthColor } from '../theme.ts';

/** How often the globe re-reads live data. Its own animation still runs at full frame rate. */
const REFRESH_MS = 1200;
const PULSING_COUNTRIES = 14;

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

interface Props {
  onCountryClick(cc: string): void;
}

const material = new MeshPhongMaterial({
  color: '#08121d',
  emissive: '#02070e',
  shininess: 6,
});

function tooltip(cc: string): string {
  const c = useGlobe.getState().countries.get(cc);
  const row = (k: string, v: string) =>
    `<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:#8ea3b5">${k}</span><span style="font-family:ui-monospace,monospace">${v}</span></div>`;
  return `<div style="background:rgba(8,13,22,.92);border:1px solid #1a2432;border-radius:10px;padding:10px 12px;min-width:190px;color:#e8f1f8;font:13px system-ui;backdrop-filter:blur(8px)">
    <div style="font-weight:600;margin-bottom:6px">${countryName(cc)}</div>
    ${row('Health', c?.h === undefined ? '—' : `${c.h} / 100`)}
    ${row('Route changes', c?.act === undefined ? '—' : `${formatInt(c.act)} / s`)}
    ${row('Median latency', typeof c?.p50 !== 'number' ? '—' : `${c.p50} ms`)}
    <div style="margin-top:6px;color:#55677a;font-size:11px">Click to open</div>
  </div>`;
}

/**
 * The hero: a dark globe whose land is a field of dots coloured by each
 * country's network health, with every RIPE Atlas probe as a point of light
 * coloured by its latency, and ripples where routing is busiest right now.
 */
export function GlobeView({ onCountryClick }: Props) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [features, setFeatures] = useState<CountryFeature[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
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

  const { probeSets, rings, colorOf } = useMemo(() => {
    const { countries, probePos, probeBucket } = useGlobe.getState();

    const sets: ProbeSet[] = BUCKET_COLORS.map((color) => ({ color, size: 2.2, pts: [] }));
    const unknown: ProbeSet = { color: 'rgba(120,150,180,0.35)', size: 1.4, pts: [] };
    for (const [id, [lat, lng]] of probePos) {
      const b = probeBucket.get(id);
      (b === undefined ? unknown : sets[b]!).pts.push({ lat, lng });
    }

    const byActivity = [...countries]
      .filter(([, c]) => (c.act ?? 0) > 0)
      .sort((a, b) => (b[1].act ?? 0) - (a[1].act ?? 0))
      .slice(0, PULSING_COUNTRIES);
    const ringList: Ring[] = [];
    for (const [cc, c] of byActivity) {
      const label = features.find((f) => f.properties.cc === cc)?.properties;
      if (!label) continue;
      ringList.push({
        lat: label.lat,
        lng: label.lng,
        r: 1.2 + Math.log10((c.act ?? 0) + 1) * 1.6,
      });
    }

    const colors = new Map<string, string>();
    for (const f of features) {
      const cc = f.properties.cc;
      colors.set(cc, cc === hovered ? '#e8f1f8' : healthColor(countries.get(cc)?.h, 0.92));
    }
    return {
      probeSets: [unknown, ...sets],
      rings: ringList,
      colorOf: (f: object) => colors.get((f as CountryFeature).properties.cc) ?? '#1d2a3a',
    };
    // `frame` is the trigger: the data lives in the mutable store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, features, hovered]);

  function onReady() {
    const globe = globeRef.current;
    if (!globe) return;
    // Fly in from far away, then drift.
    globe.pointOfView({ lat: 24, lng: 12, altitude: 4.2 }, 0);
    globe.pointOfView({ lat: 22, lng: 18, altitude: 2.25 }, 2600);
    const controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.enableDamping = true;
    let resume: ReturnType<typeof setTimeout> | undefined;
    controls.addEventListener('start', () => {
      controls.autoRotate = false;
      clearTimeout(resume);
    });
    controls.addEventListener('end', () => {
      resume = setTimeout(() => (controls.autoRotate = true), 12_000);
    });
  }

  return (
    <div ref={boxRef} className="absolute inset-0">
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
          hexPolygonsData={features}
          hexPolygonResolution={3}
          hexPolygonMargin={0.42}
          hexPolygonUseDots
          hexPolygonAltitude={0.006}
          hexPolygonColor={colorOf}
          hexPolygonsTransitionDuration={0}
          hexPolygonLabel={(f: object) => tooltip((f as CountryFeature).properties.cc)}
          onHexPolygonHover={(f: object | null) =>
            setHovered(f ? (f as CountryFeature).properties.cc : null)
          }
          onHexPolygonClick={(f: object) => onCountryClick((f as CountryFeature).properties.cc)}
          particlesData={probeSets}
          particlesList="pts"
          particleLat="lat"
          particleLng="lng"
          particleAltitude={0.012}
          particlesColor="color"
          particlesSize="size"
          particlesSizeAttenuation={false}
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
