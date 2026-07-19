import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppProviders from './AppProviders';
import AppShell from './layout/AppShell';
import DashboardPage from './pages/DashboardPage';
import FeedPage from './pages/FeedPage';
import WalletsPage from './pages/WalletsPage';
import CallersPage from './pages/CallersPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';

const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

export default function App() {
  return (
    <BrowserRouter basename={basename}>
      <AppProviders>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="feed" element={<FeedPage />} />
            <Route path="wallets" element={<WalletsPage />} />
            <Route path="callers" element={<CallersPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="login" element={<LoginPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppProviders>
    </BrowserRouter>
  );
}
