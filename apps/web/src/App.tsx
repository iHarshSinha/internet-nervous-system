import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { IncidentAlerts, RedAlert } from './components/Incidents.tsx';
import { Header } from './components/ui.tsx';
import { startRealtime } from './realtime/client.ts';
import { initAuth } from './store/auth.ts';
import { useRoute } from './router.ts';

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
            ? 'bg-[#05070c]'
            : 'bg-gradient-to-b from-void via-void/70 to-transparent'
        }`}
      >
        <Header />
      </div>
      <Suspense fallback={<div className="min-h-dvh" />}>
        {route.page === 'country' ? (
          <CountryPage key={route.cc} cc={route.cc} />
        ) : route.page === 'me' ? (
          <MePage />
        ) : route.page === 'incident' ? (
          <IncidentPage key={route.id} id={route.id} />
        ) : route.page === 'login' ? (
          <LoginPage />
        ) : (
          <GlobePage />
        )}
      </Suspense>
      {/* Incident alerts follow you on every page except sign-in. */}
      {route.page !== 'login' && (
        <>
          <RedAlert />
          <IncidentAlerts />
        </>
      )}
    </QueryClientProvider>
  );
}
