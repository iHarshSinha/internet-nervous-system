import { create } from 'zustand';

/*
 * The wire: a short running log of what just happened, in words, for the
 * ticker under the globe. Entries are made on this page from the live stores
 * (incidents opening and recovering, new Cloudflare reports, a new busiest
 * country), so nothing extra travels over the network.
 */

export type WireTone = 'critical' | 'warning' | 'calm' | 'radar';

export interface WireItem {
  id: string;
  at: number;
  text: string;
  tone: WireTone;
  /** Where clicking it goes, if anywhere. */
  href?: string;
}

const KEEP = 14;

export const useWire = create<{ items: WireItem[] }>(() => ({ items: [] }));

/** Add an entry (ignored if an entry with the same id is already there). */
export function wire(item: Omit<WireItem, 'at'> & { at?: number }): void {
  useWire.setState((s) => {
    if (s.items.some((x) => x.id === item.id)) return s;
    return { items: [{ ...item, at: item.at ?? Date.now() }, ...s.items].slice(0, KEEP) };
  });
}
