import { MessageSquare, Wallet, TrendingUp, PieChart, Radio, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuthSession } from '../hooks/useAuthSession';
import ActivationChecklist from '../components/onboarding/ActivationChecklist';
import { useAppStore } from '../stores/appStore';
import { routes } from '../lib/routes';
import { USER_DOCS_URL } from '../lib/links';
import { cn } from '../lib/utils';
import { fadeInUp, m, MotionFeatures, useStagger, useTransition } from '../lib/motion';
import { EYEBROW_CLASS } from '../components/console/eyebrow';

// ── Console home ──────────────────────────────────────────────────────────────
// Density + type pass on the design-token foundation (see AuthPage for the
// worked example). Everything here is static chrome — no stream, no
// virtualised list — so the staggered entrance is allowed. Motion arrives
// through this lazily-loaded chunk and stays off the boot path.

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

/**
 * Connection health for the session card. Colour carries meaning here, so it
 * comes from the semantic status set rather than the brand accent or the
 * per-platform brand colours (`oct-telegram`, `oct-yellow`) it used before:
 * connected = good, configured-but-not-connected = warn, unlinked = neutral.
 */
type Health = 'good' | 'warn' | 'off';

const healthClass = (health: Health) =>
  cn(
    'type-data text-oct-muted',
    health === 'good' && 'text-oct-good',
    health === 'warn' && 'text-oct-warn',
  );

export default function DashboardPage() {
  const { isAuthenticated } = useAuthSession();
  const authStatus = useAppStore((s) => s.authStatus);
  const connected = useAppStore((s) => s.connected);
  const rooms = useAppStore((s) => s.rooms);

  const discordConfigured = authStatus?.configured ?? false;
  const telegramConfigured = authStatus?.telegramConfigured ?? false;
  const telegramConnected = authStatus?.telegramConnected ?? false;

  const discordHealth: Health = discordConfigured ? (connected ? 'good' : 'warn') : 'off';
  const telegramHealth: Health = telegramConfigured ? (telegramConnected ? 'good' : 'warn') : 'off';

  // Both resolve to an instant transition under `prefers-reduced-motion`.
  const enter = useTransition('snappy');
  const stagger = useStagger();

  return (
    <div className="h-full overflow-y-auto bg-oct-bg">
      {/* Brand banner. Kept, but at half its old height: the home is a command
          surface, so the modules should be above the fold, not the slogan. */}
      <section className="relative overflow-hidden bg-gradient-to-br from-oct-flame to-oct-accent text-black px-roomy sm:px-gutter py-section sm:py-gutter border-b border-oct-border shadow-oct-soft">
        <div className="max-w-6xl mx-auto relative">
          <p className="type-caption font-mono uppercase tracking-[0.24em] mb-comfy opacity-80">[ Console ]</p>
          <h1 className="font-display text-[clamp(1.75rem,5vw,3.25rem)] leading-[0.95] tracking-tight">
            PICK A MODULE.
            <span className="block">GET TO WORK.</span>
          </h1>
          <p className="font-mono type-label font-normal mt-comfy max-w-xl opacity-80 leading-relaxed">
            Session status and quick actions below. Feed needs a Discord token in Settings — it never leaves your browser.
          </p>
        </div>
      </section>

      <section className="px-roomy sm:px-gutter py-section">
        {/* Stagger parent. Each card below opts in with `variants={fadeInUp}`. */}
        <MotionFeatures>
          <m.div variants={stagger} initial="hidden" animate="visible" className="max-w-6xl mx-auto">
            {/* Renders nothing once the user has reached a first signal (or dismissed it). */}
            <ActivationChecklist />
            <p className={cn(EYEBROW_CLASS, 'tracking-[0.2em] mb-comfy')}>Modules</p>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-comfy">
              {modules.map((mod) => {
                const Icon = mod.icon;
                const isLive =
                  mod.liveKey === 'discord' ? discordConfigured && connected :
                  mod.liveKey === 'auth' ? isAuthenticated :
                  false;

                return (
                  <m.div key={mod.title} variants={fadeInUp} transition={enter} className="flex">
                    <Link
                      to={mod.to}
                      className="group oct-card flex flex-1 flex-col p-roomy transition-all duration-fast hover:-translate-y-0.5 hover:shadow-oct-soft-lg hover:border-oct-border-bright"
                    >
                      <div className="flex items-center justify-between mb-comfy">
                        <span className={cn(EYEBROW_CLASS, 'tabular-nums')}>{mod.num}</span>
                        <span className="flex items-center justify-center w-8 h-8 rounded-oct border border-oct-border bg-oct-surface-raised/60 text-oct-muted group-hover:text-oct-accent group-hover:border-oct-accent/50 transition-colors duration-fast">
                          <Icon size={16} />
                        </span>
                      </div>
                      <h2 className="font-display text-2xl text-oct-text tracking-tight mb-cozy">{mod.title}</h2>
                      <p className="type-body text-oct-muted leading-relaxed flex-1">{mod.desc}</p>
                      <div className="flex items-center justify-between mt-roomy pt-comfy border-t border-oct-border">
                        <span className="type-caption font-mono uppercase tracking-[0.14em] text-oct-accent group-hover:translate-x-1 transition-transform duration-fast inline-flex items-center gap-snug">
                          Enter <ArrowRight size={14} />
                        </span>
                        {/* Live = a healthy connection, so it is `oct-good`, not the accent. */}
                        {isLive && (
                          <span className="type-caption font-mono uppercase tracking-[0.12em] text-oct-good flex items-center gap-snug">
                            <span className="w-1.5 h-1.5 rounded-full bg-oct-good animate-pulse-live" />
                            Live
                          </span>
                        )}
                      </div>
                    </Link>
                  </m.div>
                );
              })}
            </div>

            <div className="mt-roomy grid grid-cols-1 sm:grid-cols-2 gap-comfy">
              <m.div variants={fadeInUp} transition={enter} className="oct-card p-roomy">
                <div className="flex items-center gap-cozy mb-comfy">
                  <Radio size={16} className="text-oct-accent-2" />
                  <h3 className="type-title text-oct-text uppercase tracking-wide">Session</h3>
                </div>
                <ul className="space-y-cozy">
                  <li className="flex items-center justify-between gap-roomy">
                    <span className={EYEBROW_CLASS}>Account</span>
                    <span className="type-data text-oct-text">{isAuthenticated ? 'SIGNED_IN' : 'GUEST'}</span>
                  </li>
                  <li className="flex items-center justify-between gap-roomy">
                    <span className={EYEBROW_CLASS}>Discord</span>
                    <span className={healthClass(discordHealth)}>
                      {discordConfigured ? (connected ? 'CONNECTED' : 'CONNECTING') : 'NOT_LINKED'}
                    </span>
                  </li>
                  <li className="flex items-center justify-between gap-roomy">
                    <span className={EYEBROW_CLASS}>Telegram</span>
                    <span className={healthClass(telegramHealth)}>
                      {telegramConfigured
                        ? telegramConnected
                          ? 'CONNECTED'
                          : 'DISCONNECTED'
                        : 'NOT_LINKED'}
                    </span>
                  </li>
                  <li className="flex items-center justify-between gap-roomy">
                    <span className={EYEBROW_CLASS}>Rooms</span>
                    <span className="type-data text-base font-bold text-oct-text">{rooms.length}</span>
                  </li>
                </ul>
              </m.div>

              <m.div variants={fadeInUp} transition={enter} className="oct-card p-roomy flex flex-col justify-between">
                <div>
                  <p className={cn(EYEBROW_CLASS, 'mb-cozy')}>Quick start</p>
                  <p className="type-body text-oct-muted leading-relaxed">
                    {discordConfigured
                      ? 'Open Feed to stream channels, or configure rooms in Settings.'
                      : 'Open Feed to watch the demo feed — no token needed. Connect Discord there when you want your own servers.'}
                  </p>
                </div>
                {/* Un-connected users go to Feed, not Settings: the demo feed and
                    the token form both live on Feed; Settings only has the form. */}
                <div className="mt-roomy flex flex-wrap items-center gap-roomy">
                  <Link
                    to={routes.feed}
                    className="oct-btn-primary self-start px-roomy py-cozy type-label font-mono uppercase tracking-[0.12em]"
                  >
                    Open Feed
                    <ArrowRight size={14} />
                  </Link>
                  <a
                    href={USER_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="type-caption font-mono uppercase tracking-[0.12em] text-oct-muted underline underline-offset-4 transition-colors duration-fast hover:text-oct-text"
                  >
                    User guide
                  </a>
                </div>
              </m.div>
            </div>
          </m.div>
        </MotionFeatures>
      </section>
    </div>
  );
}
