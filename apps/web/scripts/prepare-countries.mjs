// Build apps/web/public/geo/countries.json from Natural Earth (public domain).
//
//   node apps/web/scripts/prepare-countries.mjs
//
// Source: https://www.naturalearthdata.com/ via the official GitHub mirror,
// "Admin 0 - Countries" at 1:110m scale. We keep only what the globe needs:
// the ISO 2-letter code, the name, a label point and the outline, with
// coordinates rounded to 0.01 degrees (about 1 km), which is far finer than
// the 1:110m shapes themselves.
//
// India's boundary follows the Government of India's position (the whole of
// Jammu & Kashmir and Ladakh including Aksai Chin, and Arunachal Pradesh).
// Natural Earth publishes that as its "India point of view" edition, only at
// 1:10m scale, so India, Pakistan and China are taken from that file and
// simplified here to match the detail of the other countries.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const OUT = new globalThis.URL('../public/geo/countries.json', import.meta.url);

const POV_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries_ind.geojson';
/** Countries whose outline comes from the India point-of-view edition. */
const POV_COUNTRIES = new Set(['IN', 'PK', 'CN']);

const res = await fetch(URL);
if (!res.ok) throw new Error(`HTTP ${res.status} from ${URL}`);
const source = await res.json();

// The point-of-view file is 13 MB; pass a local copy as the first argument to skip the download.
const local = process.argv[2];
const pov =
  local && existsSync(local)
    ? JSON.parse(readFileSync(local, 'utf8'))
    : await fetch(POV_URL).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} from ${POV_URL}`);
        return r.json();
      });

const round = (n) => Math.round(n * 100) / 100;

/** Shoelace area of a ring, in square degrees (sign ignored). */
const area = (ring) =>
  Math.abs(
    ring.reduce((sum, [x1, y1], i) => {
      const [x2, y2] = ring[(i + 1) % ring.length];
      return sum + x1 * y2 - x2 * y1;
    }, 0),
  ) / 2;

/**
 * Round a ring and drop repeated points. Rounding can collapse a tiny island
 * into a single point (it happened to a North Korean sliver), and the globe's
 * hexagon library throws on such a ring, so degenerate rings return null.
 */
function cleanRing(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const pt = [round(x), round(y)];
    const last = out.at(-1);
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) out.push(pt);
  }
  const first = out[0];
  const last = out.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) out.push(first); // keep it closed
  return out.length >= 4 && area(out) > 0.0001 ? out : null;
}

/** Clean a polygon (outer ring + holes); null if its outer ring is degenerate. */
function cleanPolygon(rings) {
  const [outer, ...holes] = rings.map(cleanRing);
  return outer ? [outer, ...holes.filter(Boolean)] : null;
}

function cleanGeometry(g) {
  if (g.type === 'Polygon') {
    const poly = cleanPolygon(g.coordinates);
    return poly && { type: 'Polygon', coordinates: poly };
  }
  const polys = g.coordinates.map(cleanPolygon).filter(Boolean);
  return polys.length > 0 ? { type: 'MultiPolygon', coordinates: polys } : null;
}

/** Distance from point p to the segment a-b, in degrees. */
function distance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t =
    len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker: drop points that bend the line by less than `tolerance` degrees. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop();
    let worst = 0;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const d = distance(points[i], points[from], points[to]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at !== -1 && worst > tolerance) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A 1:10m geometry reduced to about 1:110m detail: small islands dropped, lines simplified. */
function coarsen(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const out = [];
  for (const [outer] of polys) {
    if (area(outer) < 0.05) continue; // islets (holes are dropped too: none matter at this scale)
    // Split the closed ring in two so the simplifier has fixed end points on both halves.
    const mid = outer.length >> 1;
    const ring = [
      ...simplify(outer.slice(0, mid + 1), 0.06),
      ...simplify(outer.slice(mid), 0.06).slice(1),
    ];
    out.push([ring]);
  }
  return { type: 'MultiPolygon', coordinates: out };
}

const povGeometry = new Map();
for (const f of pov.features) {
  if (POV_COUNTRIES.has(f.properties.ISO_A2))
    povGeometry.set(f.properties.ISO_A2, coarsen(f.geometry));
}
for (const cc of POV_COUNTRIES) if (!povGeometry.has(cc)) throw new Error(`no ${cc} in ${POV_URL}`);

const features = [];
for (const f of source.features) {
  const p = f.properties;
  // ISO_A2 is "-99" for a few countries (France, Norway); the "_EH" field fills those in.
  const cc = p.ISO_A2 !== '-99' ? p.ISO_A2 : p.ISO_A2_EH;
  if (!/^[A-Z]{2}$/.test(cc) || cc === 'AQ') continue; // skip unrecognised areas and Antarctica
  const geometry = cleanGeometry(povGeometry.get(cc) ?? f.geometry);
  if (!geometry) continue;
  features.push({
    type: 'Feature',
    properties: { cc, name: p.NAME, lat: round(p.LABEL_Y), lng: round(p.LABEL_X) },
    geometry,
  });
}

// Check the claim above: these places must fall inside India's outline.
function inside([x, y], geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let hit = false;
  for (const [ring] of polys) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}
const india = features.find((f) => f.properties.cc === 'IN').geometry;
for (const [name, point] of [
  ['Aksai Chin', [79.5, 35.0]],
  ['Gilgit', [74.3, 35.9]],
  ['Muzaffarabad', [73.47, 34.37]],
  ['Tawang', [91.86, 27.59]],
  ['Port Blair', [92.73, 11.67]],
]) {
  if (!inside(point, india)) throw new Error(`${name} is not inside India's outline`);
}

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
process.stdout.write(`wrote ${features.length} countries to ${OUT.pathname}\n`);
