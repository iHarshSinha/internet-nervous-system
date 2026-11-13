/*
 * Colour meanings, in one place so the globe, charts and legends agree.
 *
 * Health uses one sequential scale from calm cyan (healthy) to amber
 * (degraded). Red appears only below 25, where something is clearly broken,
 * so red always means something.
 */

export const colors = {
  void: '#04060b',
  line: '#1a2432',
  hi: '#e8f1f8',
  mid: '#8ea3b5',
  low: '#55677a',
  signal: '#5ee6ff',
  caution: '#ffb454',
  critical: '#ff4d5e',
  /** A country we have no data for yet. */
  unknown: '#1d2a3a',
  announce: '#5ee6ff',
  withdraw: '#ffb454',
} as const;

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const mix = (a: RGB, b: RGB, t: number): RGB =>
  a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as RGB;
const css = ([r, g, b]: RGB, alpha = 1) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

const HEALTHY = hex('#5ee6ff');
const WATCH = hex('#9b8cff');
const DEGRADED = hex('#ffb454');
const BROKEN = hex('#ff4d5e');

/** Colour for a health score; dim grey-blue when unknown. */
export function healthColor(h: number | undefined, alpha = 1): string {
  if (h === undefined) return css(hex(colors.unknown), alpha);
  if (h >= 90) return css(HEALTHY, alpha);
  if (h >= 60) return css(mix(WATCH, HEALTHY, (h - 60) / 30), alpha);
  if (h >= 25) return css(mix(DEGRADED, WATCH, (h - 25) / 35), alpha);
  return css(BROKEN, alpha);
}

/** Probe dot colours by latency bucket (see LATENCY_BUCKETS_MS), last = no reply. */
export const BUCKET_COLORS = ['#5ee6ff', '#5aa9ff', '#9b8cff', '#d78cff', '#ffb454', '#ff6b6b'];
export const BUCKET_LABELS = ['< 20 ms', '20–50', '50–100', '100–200', '> 200 ms', 'no reply'];

export const formatInt = new Intl.NumberFormat('en-US').format;

/** Flag emoji from a 2-letter country code. */
export function flag(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
