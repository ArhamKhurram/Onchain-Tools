import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Rocket } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { isHostedMode, getSupabase } from '../lib/supabase';
import { LANDING_URL, routes } from '../lib/routes';
import { useAppStore } from '../stores/appStore';
import { useUpdatesUiStore } from '../stores/updatesUiStore';
import { UPDATE_SLIDES } from '../data/updates';
import { getSeenIds } from '../utils/announcements';
import { useThemeStore } from '../stores/themeStore';
import ThemeToggle from '../components/ThemeToggle';

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: routes.home, label: 'Home', end: true },
  { to: routes.feed, label: 'Feed' },
  { to: routes.wallets, label: 'Wallets' },
  { to: routes.portfolio, label: 'Portfolio' },
  { to: routes.callers, label: 'Callers' },
  { to: routes.workspace, label: 'Workspace' },
  { to: routes.settings, label: 'Settings' },
];

function navClass({ isActive }: { isActive: boolean }) {
  return [
    'px-2.5 py-1 text-[11px] sm:text-xs font-mono uppercase tracking-[0.14em] transition-opacity',
    isActive ? 'text-oct-accent opacity-100' : 'text-oct-muted opacity-70 hover:opacity-100',
  ].join(' ');
}

export default function AppShell() {
  const { isAuthenticated, user } = useAuthSession();
  const navigate = useNavigate();
  const config = useAppStore((s) => s.config);
  const openChangelog = useUpdatesUiStore((s) => s.openChangelog);
  const hydrateTheme = useThemeStore((s) => s.hydrate);

  useEffect(() => {
    hydrateTheme();
  }, [hydrateTheme]);

  const unseenCount = UPDATE_SLIDES.filter((s) => {
    const seen = new Set([...getSeenIds(), ...(config?.seenAnnouncements ?? [])]);
    return !seen.has(s.id);
  }).length;

  const handleSignOut = async () => {
    if (isHostedMode) {
      await getSupabase().auth.signOut();
    }
    navigate(routes.home);
  };

  return (
    <div className="flex flex-col h-full w-full bg-oct-bg font-sans">
      <header className="relative shrink-0 h-12 px-4 sm:px-6 flex items-center gap-4 border-b-2 border-oct-border bg-oct-panel">
        <a
          href={LANDING_URL}
          className="font-display text-lg sm:text-xl tracking-tight text-oct-text hover:opacity-90 transition-opacity shrink-0"
          title="Back to landing page"
        >
          OCT
        </a>

        <span className="hidden md:inline font-mono text-[10px] uppercase tracking-[0.2em] text-oct-muted/80">
          ONCHAIN.TOOLS
        </span>

        <nav className="flex items-center gap-1 sm:gap-2 flex-1 min-w-0 overflow-x-auto scrollbar-none ml-2 sm:ml-6">
          {NAV.map(({ to, label, end }) => (
            <NavLink key={to} to={to} end={end} className={navClass}>
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <ThemeToggle />
          <button
            type="button"
            onClick={openChangelog}
            className="relative p-1.5 rounded-cockpit text-oct-muted hover:text-oct-accent border-2 border-transparent hover:border-oct-border-bright transition-colors"
            title="What's new"
            aria-label="What's new"
          >
            <Rocket size={16} strokeWidth={2} />
            {unseenCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-oct-accent border border-oct-bg" />
            )}
          </button>
          {isHostedMode && !isAuthenticated ? (
            <button
              type="button"
              onClick={() => navigate(routes.login)}
              className="font-mono text-[10px] sm:text-xs uppercase tracking-[0.12em] text-oct-text border-2 border-oct-border-bright px-2.5 py-1 hover:bg-oct-accent hover:text-white hover:border-oct-accent transition-colors"
            >
              [ SIGN IN ]
            </button>
          ) : isAuthenticated && user ? (
            <div className="group flex items-center gap-2">
              <span
                className="hidden sm:inline font-mono text-[10px] text-oct-muted max-w-[140px] truncate"
                title={user.email ?? undefined}
              >
                <span className="group-hover:hidden">Signed in</span>
                <span className="hidden group-hover:inline">{user.email}</span>
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                className="font-mono text-[10px] text-oct-muted hover:text-oct-text transition-colors uppercase"
              >
                Out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
