import { create } from 'zustand';

/*
 * Times on screen are shown in the viewer's own time zone. The browser knows
 * it from the device's settings (no location permission needed). Clicking
 * the clock switches everything to UTC and back; UTC is also the fallback
 * if the browser cannot say. The choice is remembered in this browser.
 */

const browserZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

const KEY = 'ins:clock';

function savedLocal(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'utc';
  } catch {
    return true;
  }
}

export const useClockZone = create<{ local: boolean }>(() => ({ local: savedLocal() }));

export function toggleZone(): void {
  const local = !useClockZone.getState().local;
  useClockZone.setState({ local });
  try {
    localStorage.setItem(KEY, local ? 'local' : 'utc');
  } catch {
    // Storage unavailable (private window): the switch still works for this visit.
  }
}

/** The IANA zone in use now, for example "Asia/Kolkata" or "UTC". */
export function zone(): string {
  return useClockZone.getState().local ? browserZone : 'UTC';
}

const labels = new Map<string, string>();

/**
 * The zone's short name: "IST", "CET", "EST"... Each language only knows the
 * abbreviations of its own region (US English calls India "GMT+5:30"), so
 * the viewer's language is tried first, then a few English variants, and
 * "GMT+5:30" is used only if none has a real abbreviation.
 */
export function zoneLabel(z: string = zone()): string {
  if (z === 'UTC') return 'UTC';
  const known = labels.get(z);
  if (known) return known;
  let label = z;
  for (const locale of [navigator.language, 'en-IN', 'en-GB', 'en-US', 'en-AU', 'ja-JP']) {
    try {
      const name = new Intl.DateTimeFormat(locale, { timeZone: z, timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value;
      if (!name) continue;
      if (label === z) label = name; // the first answer, kept if nothing better turns up
      if (!/^(GMT|UTC)[+-]/.test(name)) {
        label = name;
        break;
      }
    } catch {
      // An unsupported locale: try the next one.
    }
  }
  labels.set(z, label);
  return label;
}

/** "14:05" or "14:05:09" in the zone in use. */
export function formatTime(ms: number, seconds = false): string {
  return new Date(ms).toLocaleTimeString('en-GB', {
    timeZone: zone(),
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds && { second: '2-digit' }),
  });
}

export const localZoneName = browserZone;
