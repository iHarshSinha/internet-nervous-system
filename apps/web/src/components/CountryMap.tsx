import { useEffect, useMemo, useState } from 'react';
import { loadCountries, type CountryFeature } from '../geo.ts';
import { useTick } from '../hooks/tick.ts';
import { useGlobe } from '../store/globe.ts';
import { BUCKET_COLORS, healthColor } from '../theme.ts';

const W = 640;
const H = 380;
const PAD = 26;

type Ring = [number, number][];

/** All outer and inner rings of a country, as [lng, lat] pairs. */
function ringsOf(f: CountryFeature): Ring[] {
  const g = f.geometry;
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as Ring[][];
  return polys.flat();
}

/**
 * A simple equirectangular projection fitted to the country. Longitudes are
 * squeezed by cos(latitude) so shapes are not stretched, and countries that
 * cross the 180° line (Russia, Fiji) are unwrapped first.
 */
function makeProjection(points: [number, number][]) {
  const lngs = points.map(([lng]) => lng);
  const wrap = Math.max(...lngs) - Math.min(...lngs) > 180;
  const unwrap = (lng: number) => (wrap && lng < 0 ? lng + 360 : lng);
  const xs = points.map(([lng]) => unwrap(lng));
  const ys = points.map(([, lat]) => lat);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const k = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  const spanX = Math.max(0.5, (maxX - minX) * k);
  const spanY = Math.max(0.5, maxY - minY);
  const s = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const ox = (W - spanX * s) / 2;
  const oy = (H - spanY * s) / 2;
  return {
    x: (lng: number) => ox + (unwrap(lng) - minX) * k * s,
    y: (lat: number) => oy + (maxY - lat) * s,
    bounds: { minX, maxX, minY, maxY },
  };
}

/**
 * The country's outline with every RIPE Atlas probe located there, each dot
 * coloured by its latest latency. Pure SVG: no 3D engine on this page.
 */
export function CountryMap({ cc, health }: { cc: string; health: number | undefined }) {
  const [feature, setFeature] = useState<CountryFeature | null | undefined>(undefined);
  useTick(2000);

  useEffect(() => {
    void loadCountries().then((all) => setFeature(all.find((f) => f.properties.cc === cc) ?? null));
  }, [cc]);

  const { probePos, probeBucket } = useGlobe.getState();
  const probes: [number, number, number | undefined][] = [];
  for (const [id, [lat, lng, pcc]] of probePos)
    if (pcc === cc) probes.push([lng, lat, probeBucket.get(id)]);

  const shape = useMemo(() => {
    if (feature === undefined) return null;
    const rings = feature ? ringsOf(feature) : [];
    const pts: [number, number][] = rings.length
      ? rings.flat()
      : probes.map(([lng, lat]) => [lng, lat]);
    if (pts.length === 0) return null;
    const proj = makeProjection(pts);
    const path = rings
      .map(
        (ring) =>
          ring
            .map(
              ([lng, lat], i) =>
                `${i ? 'L' : 'M'}${proj.x(lng).toFixed(1)} ${proj.y(lat).toFixed(1)}`,
            )
            .join('') + 'Z',
      )
      .join('');
    return { proj, path };
    // Probes only matter for the fallback when no outline exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature, feature === null ? probes.length : 0]);

  const stroke = healthColor(health, 0.75);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-full w-full"
      role="img"
      aria-label="Map of the country with its measurement probes"
    >
      <defs>
        <radialGradient id="land" cx="50%" cy="40%" r="70%">
          <stop offset="0%" stopColor={healthColor(health, 0.16)} />
          <stop offset="100%" stopColor={healthColor(health, 0.03)} />
        </radialGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" fill="none" stroke="rgba(94,230,255,0.05)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#grid)" />
      {shape && (
        <>
          <path
            d={shape.path}
            fill="url(#land)"
            stroke={stroke}
            strokeWidth="1.2"
            strokeLinejoin="round"
            filter="url(#glow)"
          />
          <g filter="url(#glow)">
            {probes.map(([lng, lat, b], i) => (
              <circle
                key={i}
                cx={shape.proj.x(lng)}
                cy={shape.proj.y(lat)}
                r={b === undefined ? 1.6 : 2.4}
                fill={b === undefined ? 'rgba(140,165,190,0.45)' : BUCKET_COLORS[b]}
              />
            ))}
          </g>
        </>
      )}
      {feature === null && probes.length === 0 && (
        <text x={W / 2} y={H / 2} textAnchor="middle" fill="#55677a" fontSize="13">
          No outline at this map scale, and no Atlas probes here yet
        </text>
      )}
    </svg>
  );
}
