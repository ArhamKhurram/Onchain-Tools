import { MessageSquare, Wallet, TrendingUp, PieChart, Radio, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuthSession } from '../hooks/useAuthSession';
import { useAppStore } from '../stores/appStore';
import { routes } from '../lib/routes';

const modules = [
  {
    num: '01',
    title: 'FEED',
    desc: 'Live Discord & Telegram streams aggregated into rooms. Multi-pane layout, highlights, keyword alerts.',
    to: routes.feed,
    icon: MessageSquare,
    liveKey: 'discord' as const,
  },
  {
    num: '02',
    title: 'TRACK',
    desc: 'Private wallet watchlist scoped to your account. Alerts when addresses you care about move.',
    to: routes.wallets,
    icon: Wallet,
    liveKey: 'auth' as const,
  },
  {
    num: '03',
    title: 'PORTFOLIO',
    desc: 'Birdeye wallet dashboard for My Wallets — PnL, holdings, activity, chart and calendar.',
    to: routes.portfolio,
    icon: PieChart,
    liveKey: 'auth' as const,
  },
  {
    num: '04',
    title: 'CALL',
    desc: 'Contract radar — Solana & EVM addresses the moment they drop. One-click trade links.',
    to: routes.callers,
    icon: TrendingUp,
    liveKey: null,
  },
];

export default function DashboardPage() {
  const { isAuthenticated } = useAuthSession();
  const authStatus = useAppStore((s) => s.authStatus);
  const connected = useAppStore((s) => s.connected);
  const rooms = useAppStore((s) => s.rooms);

  const discordConfigured = authStatus?.configured ?? false;

  return (
    <div className="h-full overflow-y-auto bg-oct-bg">
      <section className="bg-oct-flame text-black px-6 sm:px-10 py-10 sm:py-14 border-b-2 border-black">
        <div className="max-w-6xl mx-auto">
          <p className="font-mono text-xs tracking-[0.2em] mb-4">[ CONSOLE ]</p>
          <h1 className="font-display text-[clamp(2.25rem,8vw,5rem)] leading-[0.92] tracking-tight">
            PICK A MODULE.
            <span className="block">GET TO WORK.</span>
          </h1>
          <p className="font-mono text-xs sm:text-sm mt-5 max-w-xl opacity-80 leading-relaxed">
            Session status and quick actions below. Feed needs a Discord token in Settings — it never leaves your browser.
          </p>
        </div>
      </section>

      <section className="px-6 sm:px-10 py-10 sm:py-12">
        <div className="max-w-6xl mx-auto">
          <p className="font-mono text-xs tracking-[0.2em] text-oct-muted mb-6">[ MODULES ]</p>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-8 md:gap-6">
            {modules.map((m) => {
              const Icon = m.icon;
              const isLive =
                m.liveKey === 'discord' ? discordConfigured && connected :
                m.liveKey === 'auth' ? isAuthenticated :
                false;

              return (
                <Link
                  key={m.title}
                  to={m.to}
                  className="group flex flex-col border-t-2 border-oct-accent pt-6 hover:opacity-90 transition-opacity"
                >
                  <div className="flex items-center justify-between mb-4">
                    <span className="font-mono text-xs tracking-[0.15em] text-oct-muted">[ {m.num} ]</span>
                    <Icon size={18} className="text-oct-muted group-hover:text-oct-accent transition-colors" />
                  </div>
                  <h2 className="font-display text-3xl sm:text-4xl text-oct-text tracking-tight mb-3">{m.title}</h2>
                  <p className="font-mono text-xs sm:text-sm text-oct-muted leading-relaxed flex-1">{m.desc}</p>
                  <div className="flex items-center justify-between mt-6">
                    <span className="font-mono text-xs tracking-wide text-oct-accent group-hover:translate-x-1 transition-transform inline-flex items-center gap-1">
                      ENTER <ArrowRight size={14} />
                    </span>
                    {isLive && (
                      <span className="font-mono text-[10px] text-oct-accent uppercase tracking-wide flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-oct-accent animate-pulse-live" />
                        Live
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="border-2 border-black bg-oct-surface p-5 shadow-oct-hard-sm">
              <div className="flex items-center gap-2 mb-3">
                <Radio size={16} className="text-oct-accent" />
                <h3 className="font-mono text-xs uppercase tracking-[0.15em] text-oct-text">Session</h3>
              </div>
              <ul className="font-mono text-[11px] text-oct-muted space-y-2">
                <li className="flex justify-between gap-4">
                  <span>ACCOUNT</span>
                  <span className="text-oct-text">{isAuthenticated ? 'SIGNED_IN' : 'GUEST'}</span>
                </li>
                <li className="flex justify-between gap-4">
                  <span>DISCORD</span>
                  <span className={discordConfigured ? 'text-oct-accent' : 'text-oct-muted'}>
                    {discordConfigured ? (connected ? 'CONNECTED' : 'CONNECTING') : 'NOT_LINKED'}
                  </span>
                </li>
                <li className="flex justify-between gap-4">
                  <span>ROOMS</span>
                  <span className="text-oct-text tabular-nums">{rooms.length}</span>
                </li>
              </ul>
            </div>

            <div className="border-2 border-black bg-oct-surface p-5 shadow-oct-hard-sm flex flex-col justify-between">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.15em] text-oct-muted mb-2">Quick start</p>
                <p className="text-sm text-oct-muted leading-relaxed">
                  {discordConfigured
                    ? 'Open Feed to stream channels, or configure rooms in Settings.'
                    : 'Connect Discord in Feed or Settings → Tokens to start streaming.'}
                </p>
              </div>
              <Link
                to={discordConfigured ? routes.feed : routes.settings}
                className="mt-4 inline-flex font-mono text-xs uppercase tracking-wide text-oct-accent hover:underline"
              >
                {discordConfigured ? 'Open Feed →' : 'Connect Discord →'}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
