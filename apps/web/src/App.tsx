import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { IncidentAlerts, RedAlert } from './components/Incidents.tsx';
import { Hud } from './components/Hud.tsx';
import { Header } from './components/ui.tsx';
import { startRealtime } from './realtime/client.ts';
import { initAuth } from './store/auth.ts';
import { useRoute, type Route } from './router.ts';

const routeKey = (r: Route) =>
  r.page === 'country' ? `c:${r.cc}` : r.page === 'incident' ? `i:${r.id}` : r.page;

// Each page is its own download: the globe brings three.js, the country page uPlot.
const GlobePage = lazy(() =>
  import('./pages/GlobePage.tsx').then((m) => ({ default: m.GlobePage })),
);
const LoginPage = lazy(() =>
  import('./pages/LoginPage.tsx').then((m) => ({ default: m.LoginPage })),
);
const MePage = lazy(() => import('./pages/MePage.tsx').then((m) => ({ default: m.MePage })));
const CountryPage = lazy(() =>
  import('./pages/CountryPage.tsx').then((m) => ({ default: m.CountryPage })),
);

const FeedPage = lazy(() => import('./pages/FeedPage.tsx').then((m) => ({ default: m.FeedPage })));

const OpsPage = lazy(() => import('./pages/OpsPage.tsx').then((m) => ({ default: m.OpsPage })));

const IncidentPage = lazy(() =>
  import('./pages/IncidentPage.tsx').then((m) => ({ default: m.IncidentPage })),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false } },
});

export function App() {
  useEffect(startRealtime, []);
  useEffect(() => void initAuth(), []);
  const route = useRoute((s) => s.route);

  return (
    <QueryClientProvider client={queryClient}>
      <div
        className={`pointer-events-none fixed inset-x-0 top-0 z-30 pb-6 ${
          route.page === 'login'
            ? 'bg-[#0d0e10]'
            : 'bg-gradient-to-b from-void via-void/70 to-transparent'
        }`}
      >
        <Header />
      </div>
      <Suspense fallback={<div className="min-h-dvh" />}>
        {/* Each page fades in. Opacity only: a transform here would break the pages' fixed layers. */}
        <div key={routeKey(route)} className="animate-[fade_.5s_ease-out_both]">
          {route.page === 'country' ? (
            <CountryPage key={route.cc} cc={route.cc} />
          ) : route.page === 'me' ? (
            <MePage />
          ) : route.page === 'incident' ? (
            <IncidentPage key={route.id} id={route.id} />
          ) : route.page === 'ops' ? (
            <OpsPage />
          ) : route.page === 'feed' ? (
            <FeedPage />
          ) : route.page === 'login' ? (
            <LoginPage />
          ) : (
            <GlobePage />
          )}
        </div>
      </Suspense>
      {/* Incident alerts follow you on every page except sign-in. */}
      {route.page !== 'login' && (
        <>
          <RedAlert />
          <IncidentAlerts />
        </>
      )}
      <Hud />
    </QueryClientProvider>
  );
}
