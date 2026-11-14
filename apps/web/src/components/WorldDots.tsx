import { useEffect, useRef } from 'react';
import { countryInfo, loadCountries, type CountryFeature } from '../geo.ts';
import { useGlobe } from '../store/globe.ts';
import { activeIncidents, useIncidents } from '../store/incidents.ts';
import { useRadar } from '../store/radar.ts';

/*
 * The world as a field of dots, drifting slowly sideways and wrapping around.
 * It is a flat map on purpose (the sign-in page is calm and flat): land is a
 * dot grid, countries light up with their live routing activity, ripples
 * mark the busiest ones, and Cloudflare's attack corridors arc between
 * countries. Everything comes from the same live stores as the globe.
 *
 * Drawn on a 2D canvas: the land is rendered once to an off-screen image, so
 * each frame only moves that image and draws the few things that change.
 */

const LAT_TOP = 78;
const LAT_BOTTOM = -56;
const STEP = 1.5; // degrees between dots
const DRIFT = 9; // pixels per second

type Ring = [number, number][];
interface Dot {
  lng: number;
  lat: number;
  cc: string;
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Which grid points are land, and whose. Bounding boxes keep it to a few milliseconds. */
function landDots(features: CountryFeature[]): Dot[] {
  const shapes: { cc: string; ring: Ring; box: [number, number, number, number] }[] = [];
  for (const f of features) {
    const g = f.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as Ring[][];
    for (const [outer] of polys) {
      if (!outer) continue;
      let [x0, x1, y0, y1] = [180, -180, 90, -90];
      for (const [x, y] of outer) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      shapes.push({ cc: f.properties.cc, ring: outer, box: [x0, x1, y0, y1] });
    }
  }
  const dots: Dot[] = [];
  for (let lat = LAT_TOP; lat >= LAT_BOTTOM; lat -= STEP) {
    for (let lng = -180; lng < 180; lng += STEP) {
      for (const s of shapes) {
        const [x0, x1, y0, y1] = s.box;
        if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
        if (inRing(lng, lat, s.ring)) {
          dots.push({ lng, lat, cc: s.cc });
          break;
        }
      }
    }
  }
  return dots;
}

export function WorldDots() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let alive = true;
    let dots: Dot[] = [];
    let base: HTMLCanvasElement | null = null;
    let mapW = 0;
    let mapH = 0;
    const ripples: { lng: number; lat: number; born: number; rgb: string }[] = [];
    let lastRipple = 0;
    const started = performance.now();

    const x = (lng: number) => ((lng + 180) / 360) * mapW;
    const y = (lat: number) => ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * mapH;

    /** The static land, drawn once per size. */
    function renderBase(dpr: number) {
      base = document.createElement('canvas');
      base.width = Math.round(mapW * dpr);
      base.height = Math.round(mapH * dpr);
      const b = base.getContext('2d');
      if (!b) return;
      b.scale(dpr, dpr);
      b.fillStyle = 'rgba(169, 185, 203, 0.3)';
      const r = Math.max(1, mapW / 1500);
      for (const d of dots) {
        b.beginPath();
        b.arc(x(d.lng), y(d.lat), r, 0, Math.PI * 2);
        b.fill();
      }
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      // The map is as tall as 66% of the panel and wider than it: it drifts through.
      mapH = h * 0.66;
      mapW = mapH * (360 / (LAT_TOP - LAT_BOTTOM));
      if (dots.length > 0) renderBase(dpr);
    }

    function draw(now: number) {
      if (!alive) return;
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, w, h);
      if (!base) return;

      const t = (now - started) / 1000;
      const top = (h - mapH) * 0.38; // a little above centre: the live figures sit below
      // Start centred on Europe and Asia, then drift west to east for ever.
      const offset = (((mapW * 0.42 + t * DRIFT) % mapW) + mapW) % mapW;
      const fade = Math.min(1, t / 1.6); // the map fades in

      const { countries } = useGlobe.getState();
      const incidents = activeIncidents(useIncidents.getState().byId);
      const alarm = new Map<string, string>();
      for (const i of incidents) {
        if (i.cc && !alarm.has(i.cc)) {
          alarm.set(i.cc, i.severity === 'critical' ? '255, 77, 94' : '255, 180, 84');
        }
      }

      // A new ripple every so often, at a country chosen by how busy it is.
      if (now - lastRipple > 420) {
        lastRipple = now;
        const busy = [...countries].filter(([, c]) => (c.act ?? 0) > 0);
        const total = busy.reduce((sum, [, c]) => sum + Math.sqrt(c.act ?? 0), 0);
        let pick = Math.random() * total;
        for (const [cc, c] of busy) {
          pick -= Math.sqrt(c.act ?? 0);
          if (pick <= 0) {
            const info = countryInfo(cc);
            if (info) {
              ripples.push({
                lng: info.lng,
                lat: info.lat,
                born: now,
                rgb: alarm.get(cc) ?? '94, 230, 255',
              });
            }
            break;
          }
        }
        while (ripples.length > 0 && now - ripples[0]!.born > 2600) ripples.shift();
      }

      // The map is drawn twice, side by side, so the drift wraps without a seam.
      for (const shift of [-offset, mapW - offset]) {
        if (shift > w || shift + mapW < 0) continue;
        ctx!.globalAlpha = fade;
        ctx!.drawImage(base, shift, top, mapW, mapH);

        // Countries with live routing activity glow; the busier, the brighter.
        const r = Math.max(1, mapW / 1500) * 1.25;
        for (const d of dots) {
          const px = shift + x(d.lng);
          if (px < -4 || px > w + 4) continue;
          const red = alarm.get(d.cc);
          const act = countries.get(d.cc)?.act ?? 0;
          if (!red && act <= 0) continue;
          const glow = red ? 0.95 : Math.min(0.9, 0.25 + Math.log10(act + 1) * 0.28);
          ctx!.fillStyle = `rgba(${red ?? '94, 230, 255'}, ${glow * fade})`;
          ctx!.beginPath();
          ctx!.arc(px, top + y(d.lat), r, 0, Math.PI * 2);
          ctx!.fill();
        }

        // Cloudflare's attack corridors: an arc and a dot travelling along it.
        const pairs = useRadar.getState().pairs.filter((p) => p.layer === 'l7' && p.from !== p.to);
        ctx!.lineWidth = 1;
        pairs.slice(0, 8).forEach((p, i) => {
          const a = countryInfo(p.from);
          const b = countryInfo(p.to);
          if (!a || !b || Math.abs(a.lng - b.lng) > 180) return;
          const [ax, ay, bx, by] = [
            shift + x(a.lng),
            top + y(a.lat),
            shift + x(b.lng),
            top + y(b.lat),
          ];
          const [cx, cy] = [(ax + bx) / 2, Math.min(ay, by) - Math.abs(bx - ax) * 0.22];
          ctx!.strokeStyle = `rgba(255, 140, 110, ${0.28 * fade})`;
          ctx!.beginPath();
          ctx!.moveTo(ax, ay);
          ctx!.quadraticCurveTo(cx, cy, bx, by);
          ctx!.stroke();
          const k = (t * 0.22 + i * 0.37) % 1;
          const qx = (1 - k) ** 2 * ax + 2 * (1 - k) * k * cx + k ** 2 * bx;
          const qy = (1 - k) ** 2 * ay + 2 * (1 - k) * k * cy + k ** 2 * by;
          ctx!.fillStyle = `rgba(255, 170, 140, ${fade})`;
          ctx!.beginPath();
          ctx!.arc(qx, qy, 2.2, 0, Math.PI * 2);
          ctx!.fill();
        });

        for (const rp of ripples) {
          const age = (now - rp.born) / 2600;
          if (age >= 1) continue;
          ctx!.strokeStyle = `rgba(${rp.rgb}, ${(1 - age) * 0.8 * fade})`;
          ctx!.lineWidth = 1.2;
          ctx!.beginPath();
          ctx!.arc(shift + x(rp.lng), top + y(rp.lat), 3 + age * 34, 0, Math.PI * 2);
          ctx!.stroke();
        }
      }
      ctx!.globalAlpha = 1;
    }

    void loadCountries().then((features) => {
      if (!alive) return;
      dots = landDots(features);
      resize();
    });
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="absolute inset-0 h-full w-full"
      role="img"
      aria-label="A dot map of the world, lit where the internet's routing is busy right now"
    />
  );
}
