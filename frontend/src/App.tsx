import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppProviders from './AppProviders';
import AppShell from './layout/AppShell';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const FeedPage = lazy(() => import('./pages/FeedPage'));
const WalletsPage = lazy(() => import('./pages/WalletsPage'));
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));
const CallersPage = lazy(() => import('./pages/CallersPage'));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));

const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-full w-full bg-oct-bg">
      <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={basename}>
      <AppProviders>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              <Route path="feed" element={<FeedPage />} />
              <Route path="wallets" element={<WalletsPage />} />
              <Route path="portfolio" element={<PortfolioPage />} />
              <Route path="callers" element={<CallersPage />} />
              <Route path="workspace" element={<WorkspacePage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="login" element={<LoginPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AppProviders>
    </BrowserRouter>
  );
}
