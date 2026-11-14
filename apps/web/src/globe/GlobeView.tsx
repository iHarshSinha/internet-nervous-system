import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import { MeshPhongMaterial, type Object3D, type PerspectiveCamera } from 'three';
import { countryInfo, countryName, loadCountries, type CountryFeature } from '../geo.ts';
import { useGlobe } from '../store/globe.ts';
import { useLive } from '../store/live.ts';
import { useRadar } from '../store/radar.ts';
import { activeIncidents, incidentTitle, useIncidents } from '../store/incidents.ts';
import { isMajor } from '../components/Incidents.tsx';
import { navigate } from '../router.ts';
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
  /** "r, g, b" of the ripple. */
  rgb: string;
  speed: number;
  period: number;
}

/** A floating label over a country with an open incident. */
type MarkerKind = 'critical' | 'warning' | 'recovering';

/** An incident on the globe: an icon by kind, its name on hover. */
interface Marker {
  id: string;
  lat: number;
  lng: number;
  text: string;
  kind: MarkerKind;
}

const MARKER_COLOR: Record<MarkerKind, string> = {
  critical: '#ff4d5e',
  warning: '#ffb454',
  recovering: '#6fdc8c',
};

/** Small glyphs, drawn in the marker's colour with a dark mark on top. */
const MARKER_ICON: Record<MarkerKind, string> = {
  critical:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="var(--c)"/><path d="M12 6.4v7.2" stroke="#141518" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.5" fill="#141518"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6 22.6 20.9H1.4Z" fill="var(--c)" stroke="var(--c)" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9v5.6" stroke="#141518" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.7" r="1.35" fill="#141518"/></svg>',
  recovering:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="var(--c)"/><path d="m7.2 12.4 3.3 3.3 6.3-6.6" fill="none" stroke="#141518" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** Live marker elements, so each frame can switch them between dot and icon. */
const markerEls = new Map<string, { el: HTMLElement; lat: number; lng: number }>();

/** A Cloudflare attack corridor: share of layer 7 attack traffic from one country to another. */
interface Arc {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  value: number;
  label: string;
}

const INCIDENT_RGB = { critical: '255, 77, 94', warning: '255, 180, 84', watch: '155, 140, 255' };

const material = new MeshPhongMaterial({ color: '#17181b', emissive: '#08090a', shininess: 4 });

const ccOf = (f: object | null | undefined): string | null =>
  (f as CountryFeature | undefined)?.properties?.cc ?? null;

function tooltip(cc: string | null): string {
  if (!cc) return '';
  const c = useGlobe.getState().countries.get(cc);
  const row = (k: string, v: string) =>
    `<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:#8ea3b5">${k}</span><span style="font-family:ui-monospace,monospace">${v}</span></div>`;
  return `<div style="background:rgba(26,28,32,.97);border:1px solid rgba(94,230,255,.18);border-radius:12px;padding:10px 12px;min-width:200px;color:#e8f1f8;font:13px system-ui;box-shadow:0 12px 40px -12px #000">
    <div style="font-weight:600;margin-bottom:6px">${countryName(cc)}</div>
    ${row('Health', c?.h === undefined ? '—' : `${c.h} / 100`)}
    ${row('Route changes', c?.act === undefined ? '—' : `${formatInt(c.act)} / s`)}
    ${row('Median latency', typeof c?.p50 === 'number' ? `${c.p50} ms` : '—')}
    <div style="margin-top:6px;color:#55677a;font-size:11px">Click for details</div>
  </div>`;
}

/** The floating incident label (plain DOM: the globe library positions it). */
/*
 * Accessors the globe calls for each item. They live at module level on
 * purpose: the globe library rebuilds a whole layer whenever one of these
 * functions changes identity, and inline arrows are new on every render.
 * That rebuilt the incident labels every second (the flash in the corner)
 * and restarted the arcs' animation.
 */
const deselect = () => selectCountry(null);
const pickCountry = (f: object) => selectCountry(ccOf(f));
const countryLabel = (f: object) => tooltip(ccOf(f));
const clear = () => 'rgba(0,0,0,0)';
const noStroke = () => false;
const noLabel = () => '';
const ringColor = (d: object) => (t: number) => `rgba(${(d as Ring).rgb}, ${(1 - t) * 0.85})`;
const arcColor = () => ['rgba(255, 77, 94, 0.08)', 'rgba(255, 140, 110, 0.95)'];
const arcStroke = (d: object) => 0.25 + Math.min(1.2, (d as Arc).value / 6);
const arcGap = (d: object) => ((d as Arc).value * 7) % 1;
const arcLabel = (d: object) =>
  `<div style="background:rgba(26,28,32,.97);border:1px solid rgba(255,77,94,.35);border-radius:8px;padding:6px 10px;color:#ededee;font:600 13px Rajdhani,system-ui">${(d as Arc).label}</div>`;
/** Only the country shapes take the pointer (not probe dots, not land dots). */
const takesPointer = (obj: Object3D) => !(obj as { isPoints?: boolean }).isPoints && !isHexDot(obj);
/** Labels on the far side of the earth are hidden, not drawn through it. */
const hideBehindEarth = (el: HTMLElement, visible: boolean) => {
  el.style.visibility = visible ? 'visible' : 'hidden';
};

function markerElement(d: object): HTMLElement {
  const m = d as Marker;
  // The globe positions this element (it sets its transform). It starts as a
  // pulsing dot and fades in after a moment: until the globe has placed it, a
  // new element sits in the corner of the view (that was the flash).
  const wrap = document.createElement('div');
  wrap.className = 'mk';
  wrap.dataset.mode = 'dot';
  wrap.style.setProperty('--c', MARKER_COLOR[m.kind]);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mk-btn';
  button.setAttribute('aria-label', m.text);
  button.innerHTML = `<span class="mk-dot"></span><span class="mk-icon">${MARKER_ICON[m.kind]}</span><span class="mk-tip"></span>`;
  button.querySelector('.mk-tip')!.textContent = m.text;
  button.onclick = () => navigate(`/incident/${m.id}`);
  wrap.append(button);
  markerEls.set(m.id, { el: wrap, lat: m.lat, lng: m.lng });
  return wrap;
}

/** True for the land dots (or anything inside their layer). */
function isHexDot(obj: Object3D): boolean {
  for (let o: Object3D | null = obj; o; o = o.parent) {
    if ((o as { __globeObjType?: string }).__globeObjType === 'hexPolygon') return true;
  }
  return false;
}

/** The same marker object for as long as the label does not change, so the globe keeps its element. */
const markerCache = new Map<string, Marker>();
function stableMarker(m: Marker): Marker {
  const known = markerCache.get(m.id);
  if (known && known.text === m.text && known.kind === m.kind && known.lat === m.lat) return known;
  markerCache.set(m.id, m);
  return m;
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
  const onHover = useCallback((f: object | null) => setHovered(ccOf(f)), []);
  const selected = useUi((s) => s.selected);
  const [frame, setFrame] = useState(0);
  // Countries with a critical incident blink; this flips twice a second while one is open.
  const [blink, setBlink] = useState(false);
  const incidentsById = useIncidents((s) => s.byId);
  const pairs = useRadar((s) => s.pairs);
  const hasCritical = activeIncidents(incidentsById).some(
    (i) => i.severity === 'critical' && i.state === 'open',
  );

  useEffect(() => {
    if (!hasCritical) return;
    const timer = setInterval(() => setBlink((b) => !b), 600);
    return () => clearInterval(timer);
  }, [hasCritical]);

  // A new incident: fly there, so nobody watching can miss it.
  useEffect(
    () =>
      useIncidents.subscribe((state, prev) => {
        const id = state.fresh[0];
        if (!id || id === prev.fresh[0]) return;
        const incident = state.byId[id];
        // During a simulation, stay with it rather than chasing real incidents elsewhere.
        if (useLive.getState().scenario.state === 'running' && !incident?.simulated) return;
        // Only big ones move the camera; small networks flapping would make it seasick.
        if (!incident || !isMajor(incident)) return;
        const cc = incident?.cc;
        const info = cc ? countryInfo(cc) : undefined;
        const globe = globeRef.current;
        if (!info || !globe || useUi.getState().selected) return;
        globe.controls().autoRotate = false;
        globe.pointOfView({ lat: info.lat, lng: info.lng, altitude: 1.6 }, 1800);
      }),
    [],
  );

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

      // Incident markers: a full icon when facing the viewer, a pulsing dot
      // as they turn towards the edge of the globe.
      const cam = camera.position;
      for (const [id, mk] of markerEls) {
        if (!mk.el.isConnected) {
          markerEls.delete(id);
          continue;
        }
        const c = globe.getCoords(mk.lat, mk.lng, 0);
        const facing = (c.x * cam.x + c.y * cam.y + c.z * cam.z) / (radius * distance);
        const mode = facing > 0.8 ? 'icon' : 'dot';
        if (mk.el.dataset.mode !== mode) mk.el.dataset.mode = mode;
      }
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

  // Attack arcs change every 15 minutes at most: their own memo, so they never re-animate needlessly.
  const arcs = useMemo(() => {
    const list: Arc[] = [];
    for (const p of pairs) {
      if (p.layer !== 'l7' || p.from === p.to) continue;
      const a = countryInfo(p.from);
      const b = countryInfo(p.to);
      if (!a || !b) continue;
      list.push({
        startLat: a.lat,
        startLng: a.lng,
        endLat: b.lat,
        endLng: b.lng,
        value: p.value,
        label: `${countryName(p.from)} → ${countryName(p.to)} · ${p.value}% of layer 7 attack traffic (Cloudflare Radar, 24 h)`,
      });
      if (list.length === 14) break;
    }
    return list;
    // `features`: country positions are known only once the shapes have loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs, features]);

  const { probeSets, rings, colorOf, markers } = useMemo(() => {
    const { countries, probePos, probeBucket } = useGlobe.getState();

    // Incidents take over their country: red or amber land, a big ripple, a label.
    const incidentCc = new Map<string, 'critical' | 'warning' | 'watch'>();
    const markerList: Marker[] = [];
    const incidentRings: Ring[] = [];
    const labelled = new Set<string>();
    for (const i of activeIncidents(incidentsById)) {
      // One label per country: the worst incident there (the list is sorted worst first).
      if (!i.cc || labelled.has(i.cc)) continue;
      labelled.add(i.cc);
      const info = countryInfo(i.cc);
      if (!info) continue;
      const severity = i.state === 'open' ? i.severity : 'watch';
      // One network's warning should not paint its whole country: land is
      // coloured for country incidents and critical ones; others get a ripple and a label.
      if (i.asn === null || (severity === 'critical' && isMajor(i))) incidentCc.set(i.cc, severity);
      const critical = severity === 'critical';
      incidentRings.push({
        lat: info.lat,
        lng: info.lng,
        r: critical ? 14 : 9,
        rgb: INCIDENT_RGB[severity],
        speed: critical ? 6 : 4,
        period: critical ? 500 : 900,
      });
      markerList.push(
        stableMarker({
          id: i.id,
          lat: info.lat,
          lng: info.lng,
          text: `${incidentTitle(i, countryName)} · ${i.state === 'open' ? i.severity : 'recovering'}`,
          kind: i.state !== 'open' ? 'recovering' : critical ? 'critical' : 'warning',
        }),
      );
    }

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
          rgb: '94, 230, 255',
          speed: 2.2,
          period: 1100,
        });
      }
    }

    const colors = new Map<string, string>();
    for (const f of features) {
      const cc = f.properties.cc;
      const severity = incidentCc.get(cc);
      if (severity) {
        const bright = severity !== 'critical' || blink;
        colors.set(cc, `rgba(${INCIDENT_RGB[severity]}, ${bright ? 1 : 0.45})`);
        continue;
      }
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
      rings: [...incidentRings, ...ringList],
      markers: markerList,
      colorOf: (f: object) => colors.get(ccOf(f) ?? '') ?? '#2a2c31',
    };
    // `frame` is the trigger: the data lives in the mutable store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, features, hovered, selected, incidentsById, blink]);

  function onReady() {
    const globe = globeRef.current;
    if (!globe) return;
    // Development only: lets us inspect the 3D scene from the browser console.
    if (import.meta.env.DEV) (window as unknown as { __globe?: GlobeMethods }).__globe = globe;
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
          atmosphereColor="#9aa4b0"
          atmosphereAltitude={0.13}
          onGlobeReady={onReady}
          onGlobeClick={deselect}
          // Only the country shapes take the pointer. Hit-testing 15,000 probe dots
          // on every mouse move is wasted work (their tooltips once froze the
          // globe), and the land dots leave gaps, so they are skipped too.
          pointerEventsFilter={takesPointer}
          hexPolygonsData={features}
          hexPolygonResolution={3}
          hexPolygonMargin={0.42}
          hexPolygonUseDots
          hexPolygonAltitude={0.006}
          hexPolygonColor={colorOf}
          hexPolygonsTransitionDuration={0}
          // Each country again as an invisible solid shape just under its dots:
          // anywhere inside the border hovers and selects it, gaps included.
          polygonsData={features}
          polygonAltitude={0.004}
          polygonCapColor={clear}
          polygonSideColor={clear}
          polygonStrokeColor={noStroke}
          polygonsTransitionDuration={0}
          polygonLabel={countryLabel}
          onPolygonHover={onHover}
          onPolygonClick={pickCountry}
          particlesData={probeSets}
          particlesList="pts"
          particleLat="lat"
          particleLng="lng"
          particleAltitude={0.012}
          particlesColor="color"
          particlesSize="size"
          particlesSizeAttenuation={false}
          particleLabel={noLabel}
          ringsData={rings}
          ringLat="lat"
          ringLng="lng"
          ringAltitude={0.008}
          ringMaxRadius="r"
          ringColor={ringColor}
          ringPropagationSpeed="speed"
          ringRepeatPeriod="period"
          arcsData={arcs}
          arcColor={arcColor}
          arcStroke={arcStroke}
          arcDashLength={0.4}
          arcDashGap={0.6}
          arcDashInitialGap={arcGap}
          arcDashAnimateTime={2600}
          arcAltitudeAutoScale={0.2}
          arcLabel={arcLabel}
          htmlElementsData={markers}
          htmlLat="lat"
          htmlLng="lng"
          htmlAltitude={0.04}
          htmlElement={markerElement}
          htmlElementVisibilityModifier={hideBehindEarth}
        />
      )}
    </div>
  );
}
