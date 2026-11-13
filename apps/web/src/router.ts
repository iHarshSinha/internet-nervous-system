import { create } from 'zustand';

/*
 * A tiny router: a handful of pages do not justify a routing library. The URL
 * is the source of truth, so links can be shared and the back button works.
 */

export type Route =
  | { page: 'globe' }
  | { page: 'country'; cc: string }
  | { page: 'incident'; id: string }
  | { page: 'me' }
  | { page: 'login' };

export function parseRoute(path: string): Route {
  const country = /^\/c\/([A-Za-z]{2})\/?$/.exec(path);
  if (country) return { page: 'country', cc: country[1]!.toUpperCase() };
  const incident = /^\/incident\/([0-9a-f-]{36})\/?$/.exec(path);
  if (incident) return { page: 'incident', id: incident[1]! };
  if (/^\/me\/?$/.test(path)) return { page: 'me' };
  if (/^\/login\/?$/.test(path)) return { page: 'login' };
  return { page: 'globe' };
}

export const useRoute = create<{ route: Route }>(() => ({
  route: parseRoute(window.location.pathname),
}));

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  useRoute.setState({ route: parseRoute(path) });
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => {
  useRoute.setState({ route: parseRoute(window.location.pathname) });
});
