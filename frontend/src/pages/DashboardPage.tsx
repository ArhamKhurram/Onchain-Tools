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
    title: 'CALL',
    desc: 'Contract radar — Solana & EVM addresses the moment they drop. One-click trade links.',
    to: routes.callers,
    icon: TrendingUp,
    liveKey: null,
  },
  {
    num: '03',
    title: 'FOMO',
    desc: 'fomo.family in one place — live trades, leaderboard, tracked traders, token holders, trader lookup.',
    to: routes.fomo,
    icon: Radio,
    liveKey: 'auth' as const,
  },
  {
    num: '04',
    title: 'DIRECTORY',
    desc: 'Your tracked-wallet directory — on-chain addresses you watch, with alerts when they move.',
    to: routes.directory,
    icon: Wallet,
    liveKey: 'auth' as const,
  },
  {
    num: '05',
    title: 'PORTFOLIO',
    desc: 'Birdeye dashboard for your buy wallets — PnL, holdings, activity, chart and calendar.',
    to: routes.portfolio,
    icon: PieChart,
    liveKey: 'auth' as const,
  },
];

export default function DashboardPage() {
  const { isAuthenticated } = useAuthSession();
  const authStatus = useAppStore((s) => s.authStatus);
  const connected = useAppStore((s) => s.connected);
  const rooms = useAppStore((s) => s.rooms);

  const discordConfigured = authStatus?.configured ?? false;
  const telegramConfigured = authStatus?.telegramConfigured ?? false;
  const telegramConnected = authStatus?.telegramConnected ?? false;

  return (
    <div className="h-full overflow-y-auto bg-oct-bg">
      <section className="relative overflow-hidden bg-gradient-to-br from-oct-flame to-oct-accent text-black px-6 sm:px-10 py-10 sm:py-14 border-b border-oct-border shadow-oct-soft">
        <div className="max-w-6xl mx-auto relative">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] mb-4 opacity-80">[ Console ]</p>
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
          <p className="oct-eyebrow tracking-[0.2em] mb-6">Modules</p>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-5">
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
                  className="group oct-card flex flex-col p-5 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-oct-soft-lg hover:border-oct-border-bright"
                >
                  <div className="flex items-center justify-between mb-4">
                    <span className="oct-eyebrow tabular-nums">{m.num}</span>
                    <span className="flex items-center justify-center w-9 h-9 rounded-oct border border-oct-border bg-oct-surface-raised/60 text-oct-muted group-hover:text-oct-accent group-hover:border-oct-accent/50 transition-colors">
                      <Icon size={18} />
                    </span>
                  </div>
                  <h2 className="font-display text-3xl sm:text-4xl text-oct-text tracking-tight mb-3">{m.title}</h2>
                  <p className="text-[13px] text-oct-muted leading-relaxed flex-1">{m.desc}</p>
                  <div className="flex items-center justify-between mt-6 pt-4 border-t border-oct-border">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-oct-accent group-hover:translate-x-1 transition-transform inline-flex items-center gap-1.5">
                      Enter <ArrowRight size={14} />
                    </span>
                    {isLive && (
                      <span className="font-mono text-[10px] text-oct-accent uppercase tracking-[0.12em] flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-oct-accent animate-pulse-live" />
                        Live
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
            <div className="oct-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Radio size={16} className="text-oct-accent-2" />
                <h3 className="oct-section-title uppercase tracking-wide">Session</h3>
              </div>
              <ul className="space-y-2.5">
                <li className="flex items-center justify-between gap-4">
                  <span className="oct-eyebrow">Account</span>
                  <span className="font-mono text-[13px] font-semibold text-oct-text">{isAuthenticated ? 'SIGNED_IN' : 'GUEST'}</span>
                </li>
                <li className="flex items-center justify-between gap-4">
                  <span className="oct-eyebrow">Discord</span>
                  <span className={`font-mono text-[13px] font-semibold ${discordConfigured ? 'text-oct-accent' : 'text-oct-muted'}`}>
                    {discordConfigured ? (connected ? 'CONNECTED' : 'CONNECTING') : 'NOT_LINKED'}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-4">
                  <span className="oct-eyebrow">Telegram</span>
                  <span
                    className={`font-mono text-[13px] font-semibold ${
                      telegramConnected
                        ? 'text-oct-telegram'
                        : telegramConfigured
                          ? 'text-oct-yellow'
                          : 'text-oct-muted'
                    }`}
                  >
                    {telegramConfigured
                      ? telegramConnected
                        ? 'CONNECTED'
                        : 'DISCONNECTED'
                      : 'NOT_LINKED'}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-4">
                  <span className="oct-eyebrow">Rooms</span>
                  <span className="font-mono text-base font-bold text-oct-text tabular-nums">{rooms.length}</span>
                </li>
              </ul>
            </div>

            <div className="oct-card p-5 flex flex-col justify-between">
              <div>
                <p className="oct-eyebrow mb-2">Quick start</p>
                <p className="text-sm text-oct-muted leading-relaxed">
                  {discordConfigured
                    ? 'Open Feed to stream channels, or configure rooms in Settings.'
                    : 'Connect Discord in Feed or Settings → Tokens to start streaming.'}
                </p>
              </div>
              <Link
                to={discordConfigured ? routes.feed : routes.settings}
                className="oct-btn-primary mt-5 self-start px-4 py-2 font-mono text-xs uppercase tracking-[0.12em]"
              >
                {discordConfigured ? 'Open Feed' : 'Connect Discord'}
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
