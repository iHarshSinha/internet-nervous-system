/** One country outline from Natural Earth (public domain), as prepared by scripts/prepare-countries.mjs. */
export interface CountryFeature {
  type: 'Feature';
  properties: { cc: string; name: string; lat: number; lng: number };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
}

let loading: Promise<CountryFeature[]> | null = null;
const names = new Map<string, CountryFeature['properties']>();

/** Load the country outlines once; later calls share the same request. */
export function loadCountries(): Promise<CountryFeature[]> {
  loading ??= fetch('/geo/countries.json')
    .then((res) => {
      if (!res.ok) throw new Error(`countries.json: HTTP ${res.status}`);
      return res.json() as Promise<{ features: CountryFeature[] }>;
    })
    .then(({ features }) => {
      for (const f of features) names.set(f.properties.cc, f.properties);
      return features;
    });
  return loading;
}

/** Name and label point of a country, once loaded. */
export function countryInfo(cc: string): CountryFeature['properties'] | undefined {
  return names.get(cc);
}

const display = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

/** Short common name ("United States"), from the browser, then Natural Earth, then the code. */
export function countryName(cc: string): string {
  const name = display?.of(cc);
  if (name && name !== cc) return name;
  return names.get(cc)?.name ?? cc;
}
