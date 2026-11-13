import { create } from 'zustand';

export interface FlyTarget {
  lat: number;
  lng: number;
  altitude: number;
  /** Changes on every request, so asking for the same place twice still flies. */
  id: number;
}

interface UiState {
  /** Country picked on the globe (shows the quick-view card). */
  selected: string | null;
  /** Where the globe camera should fly next. */
  fly: FlyTarget | null;
}

export const useUi = create<UiState>(() => ({ selected: null, fly: null }));

let flights = 0;

export function flyTo(lat: number, lng: number, altitude = 1.9): void {
  useUi.setState({ fly: { lat, lng, altitude, id: ++flights } });
}

export function selectCountry(cc: string | null): void {
  useUi.setState({ selected: cc });
}
