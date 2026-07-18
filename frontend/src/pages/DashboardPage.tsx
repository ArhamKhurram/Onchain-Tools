import { Radio, Wallet, TrendingUp, MessageSquare } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useAppStore } from '../stores/appStore';
import DashboardCard from '../components/dashboard/DashboardCard';

export default function DashboardPage() {
  const { isAuthenticated } = useAuthSession();
  const authStatus = useAppStore((s) => s.authStatus);
  const rooms = useAppStore((s) => s.rooms);

  const discordConnected = authStatus?.configured ?? false;

  return (
    <div className="h-full overflow-y-auto bg-oct-bg">
      <div className="p-6 sm:p-8 max-w-4xl mx-auto">
        <header className="mb-8">
          <p className="inline-block font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white bg-oct-accent border-2 border-black px-2 py-0.5 mb-3 shadow-oct-hard-sm">
            SYS / OVERVIEW
          </p>
          <h1 className="text-3xl font-extrabold uppercase text-oct-text tracking-tight">Dashboard</h1>
          <p className="text-sm text-oct-muted mt-1 max-w-lg">
            Cockpit overview — select a module below or use the nav.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          <DashboardCard
            to="/dashboard/feed"
            title="Feed"
            description="Live Discord and Telegram streams in multi-pane layout."
            icon={MessageSquare}
            liveEdge={discordConnected}
            status={{
              label: discordConnected
                ? `LINK_OK · ${rooms.length} RM`
                : 'AWAIT_DISCORD → Feed',
              variant: discordConnected ? 'live' : 'pending',
              mono: true,
            }}
          />

          <DashboardCard
            to="/dashboard/wallets"
            title="Wallets"
            description="Private watchlist — scoped to your account only."
            icon={Wallet}
            status={{
              label: isAuthenticated ? 'AUTH_OK' : 'SIGN_IN_REQ →',
              variant: isAuthenticated ? 'neutral' : 'pending',
              mono: true,
            }}
          />

          <DashboardCard
            to="/dashboard/callers"
            title="Callers"
            description="Contract radar and caller velocity from your feeds."
            icon={TrendingUp}
            status={{
              label: 'PHASE_6 · OFFLINE',
              variant: 'pending',
              mono: true,
            }}
          />

          <DashboardCard
            title="Status"
            description="Runtime telemetry for this session."
            icon={Radio}
            liveEdge
          >
            <ul className="pl-8 font-mono text-[11px] text-oct-muted space-y-1.5 border-t border-oct-border pt-3 mt-1">
              <li className="flex justify-between gap-4">
                <span>ACCOUNT</span>
                <span className="text-oct-text">{isAuthenticated ? 'SIGNED_IN' : 'GUEST'}</span>
              </li>
              <li className="flex justify-between gap-4">
                <span>DISCORD_GW</span>
                <span className={discordConnected ? 'text-oct-live' : 'text-oct-muted'}>
                  {discordConnected ? 'CONNECTED' : 'STANDBY'}
                </span>
              </li>
              <li className="flex justify-between gap-4">
                <span>ROOMS</span>
                <span className="text-oct-text tabular-nums">{rooms.length}</span>
              </li>
            </ul>
          </DashboardCard>
        </div>
      </div>
    </div>
  );
}
