import { create } from 'zustand';

/*
 * A tiny router: two kinds of page do not justify a routing library. The URL
 * is the source of truth, so links can be shared and the back button works.
 */

export type Route =
  { page: 'globe' } | { page: 'country'; cc: string } | { page: 'me' } | { page: 'login' };

export function parseRoute(path: string): Route {
  const country = /^\/c\/([A-Za-z]{2})\/?$/.exec(path);
  if (country) return { page: 'country', cc: country[1]!.toUpperCase() };
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
