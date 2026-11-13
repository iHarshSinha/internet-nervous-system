// Build apps/web/public/geo/countries.json from Natural Earth (public domain).
//
//   node apps/web/scripts/prepare-countries.mjs
//
// Source: https://www.naturalearthdata.com/ via the official GitHub mirror,
// "Admin 0 - Countries" at 1:110m scale. We keep only what the globe needs:
// the ISO 2-letter code, the name, a label point and the outline, with
// coordinates rounded to 0.01 degrees (about 1 km), which is far finer than
// the 1:110m shapes themselves.
import { writeFileSync } from 'node:fs';

const URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const OUT = new globalThis.URL('../public/geo/countries.json', import.meta.url);

const res = await fetch(URL);
if (!res.ok) throw new Error(`HTTP ${res.status} from ${URL}`);
const source = await res.json();

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

const features = [];
for (const f of source.features) {
  const p = f.properties;
  // ISO_A2 is "-99" for a few countries (France, Norway); the "_EH" field fills those in.
  const cc = p.ISO_A2 !== '-99' ? p.ISO_A2 : p.ISO_A2_EH;
  if (!/^[A-Z]{2}$/.test(cc) || cc === 'AQ') continue; // skip unrecognised areas and Antarctica
  const geometry = cleanGeometry(f.geometry);
  if (!geometry) continue;
  features.push({
    type: 'Feature',
    properties: { cc, name: p.NAME, lat: round(p.LABEL_Y), lng: round(p.LABEL_X) },
    geometry,
  });
}

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
process.stdout.write(`wrote ${features.length} countries to ${OUT.pathname}\n`);
