import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { isHostedMode, getSupabase } from '../lib/supabase';
import OctLogo from '../components/OctLogo';

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: '/dashboard', label: 'Dashboard', end: true },
  { to: '/dashboard/feed', label: 'Feed' },
  { to: '/dashboard/wallets', label: 'Wallets' },
  { to: '/dashboard/callers', label: 'Callers' },
];

function navClass({ isActive }: { isActive: boolean }) {
  return [
    'px-3 py-1.5 text-sm font-bold uppercase tracking-wide rounded-cockpit border-2 transition-all duration-100',
    isActive
      ? 'text-white bg-oct-accent border-black shadow-oct-hard-sm'
      : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright',
  ].join(' ');
}

export default function AppShell() {
  const { isAuthenticated, user } = useAuthSession();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    if (isHostedMode) {
      await getSupabase().auth.signOut();
    }
    navigate('/dashboard');
  };

  return (
    <div className="flex flex-col h-full w-full bg-oct-bg font-sans">
      <header className="relative shrink-0 h-12 px-4 flex items-center gap-6 border-b-2 border-black bg-oct-surface">
        <NavLink to="/dashboard" className="flex items-center gap-2 shrink-0">
          <OctLogo size="sm" showSubtitle className="hidden sm:flex" />
          <OctLogo size="sm" className="sm:hidden" />
        </NavLink>

        <nav className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-none">
          {NAV.map(({ to, label, end }) => (
            <NavLink key={to} to={to} end={end} className={navClass}>
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <NavLink
            to="/dashboard/settings"
            className={({ isActive }) =>
              `p-2 rounded-cockpit border-2 transition-all duration-100 ${isActive ? 'text-white bg-oct-accent border-black shadow-oct-hard-sm' : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'}`
            }
            title="Settings"
          >
            <Settings size={18} />
          </NavLink>

          {isHostedMode && !isAuthenticated ? (
            <button
              type="button"
              onClick={() => navigate('/dashboard/login')}
              className="brutal-btn-ghost px-3 py-1.5 text-sm"
            >
              Sign in
            </button>
          ) : isAuthenticated && user ? (
            <div className="group flex items-center gap-2">
              <span
                className="hidden sm:inline text-xs text-oct-muted max-w-[160px] truncate"
                title={user.email ?? undefined}
              >
                <span className="group-hover:hidden">Signed in</span>
                <span className="hidden group-hover:inline">{user.email}</span>
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                className="px-2 py-1 text-xs text-oct-muted hover:text-oct-text transition-colors"
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
        <div className="cockpit-nav-stripe" aria-hidden />
      </header>

      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
