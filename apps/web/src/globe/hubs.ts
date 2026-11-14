/*
 * Where a country's internet traffic actually concentrates: its main
 * internet exchange and data-centre hub. Cloudflare Radar reports attacks
 * by country only, so an arc has to end somewhere in the country; the
 * middle of a big country (Kansas for the United States) is somewhere no
 * traffic goes. These are the well-known hubs (largest internet exchange
 * point or data-centre cluster). Countries not listed use their label point,
 * which is fine for small countries.
 */
const HUBS: Record<string, [number, number, string]> = {
  US: [39.04, -77.49, 'Ashburn, Virginia'],
  CA: [43.65, -79.38, 'Toronto'],
  MX: [19.43, -99.13, 'Mexico City'],
  BR: [-23.55, -46.63, 'São Paulo'],
  AR: [-34.6, -58.38, 'Buenos Aires'],
  CL: [-33.45, -70.67, 'Santiago'],
  CO: [4.71, -74.07, 'Bogotá'],
  PE: [-12.05, -77.04, 'Lima'],
  GB: [51.51, -0.13, 'London'],
  IE: [53.35, -6.26, 'Dublin'],
  FR: [48.86, 2.35, 'Paris'],
  DE: [50.11, 8.68, 'Frankfurt'],
  NL: [52.37, 4.9, 'Amsterdam'],
  BE: [50.85, 4.35, 'Brussels'],
  ES: [40.42, -3.7, 'Madrid'],
  PT: [38.72, -9.14, 'Lisbon'],
  IT: [45.46, 9.19, 'Milan'],
  CH: [47.38, 8.54, 'Zurich'],
  AT: [48.21, 16.37, 'Vienna'],
  PL: [52.23, 21.01, 'Warsaw'],
  CZ: [50.08, 14.44, 'Prague'],
  SE: [59.33, 18.07, 'Stockholm'],
  NO: [59.91, 10.75, 'Oslo'],
  FI: [60.17, 24.94, 'Helsinki'],
  DK: [55.68, 12.57, 'Copenhagen'],
  UA: [50.45, 30.52, 'Kyiv'],
  RU: [55.76, 37.62, 'Moscow'],
  TR: [41.01, 28.98, 'Istanbul'],
  RO: [44.43, 26.1, 'Bucharest'],
  IL: [32.09, 34.78, 'Tel Aviv'],
  AE: [25.2, 55.27, 'Dubai'],
  SA: [24.71, 46.68, 'Riyadh'],
  EG: [30.04, 31.24, 'Cairo'],
  ZA: [-26.2, 28.05, 'Johannesburg'],
  NG: [6.52, 3.38, 'Lagos'],
  KE: [-1.29, 36.82, 'Nairobi'],
  IN: [19.08, 72.88, 'Mumbai'],
  PK: [24.86, 67.0, 'Karachi'],
  BD: [23.81, 90.41, 'Dhaka'],
  CN: [31.23, 121.47, 'Shanghai'],
  HK: [22.32, 114.17, 'Hong Kong'],
  TW: [25.03, 121.57, 'Taipei'],
  KR: [37.57, 126.98, 'Seoul'],
  JP: [35.68, 139.69, 'Tokyo'],
  SG: [1.35, 103.82, 'Singapore'],
  MY: [3.14, 101.69, 'Kuala Lumpur'],
  TH: [13.76, 100.5, 'Bangkok'],
  VN: [10.82, 106.63, 'Ho Chi Minh City'],
  ID: [-6.21, 106.85, 'Jakarta'],
  PH: [14.6, 120.98, 'Manila'],
  AU: [-33.87, 151.21, 'Sydney'],
  NZ: [-36.85, 174.76, 'Auckland'],
};

/** The hub of a country, if we know it: [lat, lng, city]. */
export function hubOf(cc: string): [number, number, string] | undefined {
  return HUBS[cc];
}
