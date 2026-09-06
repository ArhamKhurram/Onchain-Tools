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
//
// Layout notes, because three things here are deliberate and easy to "tidy"
// back into the problems they solve:
//
//  1. The session readout lives INSIDE the brand band, not in a card at the
//     bottom of the page. The band used to be a slogan with a half-empty right
//     side while the one piece of live state on the screen (am I connected?)
//     sat below the fold. Merging them fills the dead space and puts the state
//     above the fold at the cost of nothing.
//  2. FEED spans two columns. Five modules in a four-column grid always left a
//     lone orphan on a second row; 2+1+1+1+1 = six cells divides cleanly by
//     both three (xl) and two (md), so no breakpoint is ragged — and the span
//     doubles as the hierarchy cue that FEED is the module to open first.
//  3. Every module footer is identical (ENTER only). The live dot moved up to
//     the header rail, so cards no longer differ in footer shape depending on
//     whether their subsystem happens to be connected.

const modules = [
  {
    num: '01',
    title: 'FEED',
    desc: 'Live Discord & Telegram streams aggregated into rooms. Multi-pane layout, highlights, keyword alerts.',
    to: routes.feed,
    icon: MessageSquare,
    liveKey: 'discord' as const,
    /** The flagship module — spans two columns and carries the accent edge. */
    featured: true,
  },
  {
    num: '02',
    title: 'CALL',
    desc: 'Contract radar — Solana & EVM addresses the moment they drop. One-click trade links.',
    to: routes.callers,
    icon: TrendingUp,
    liveKey: null,
    featured: false,
  },
  {
    num: '03',
    title: 'FOMO',
    desc: 'fomo.family in one place — live trades, leaderboard, tracked traders, token holders, trader lookup.',
    to: routes.fomo,
    icon: Radio,
    liveKey: 'auth' as const,
    featured: false,
  },
  {
    num: '04',
    title: 'DIRECTORY',
    desc: 'Your tracked-wallet directory — on-chain addresses you watch, with alerts when they move.',
    to: routes.directory,
    icon: Wallet,
    liveKey: 'auth' as const,
    featured: false,
  },
  {
    num: '05',
    title: 'PORTFOLIO',
    desc: 'Birdeye dashboard for your buy wallets — PnL, holdings, activity, chart and calendar.',
    to: routes.portfolio,
    icon: PieChart,
    liveKey: 'auth' as const,
    featured: false,
  },
];

/**
 * Connection health for the session readout. Colour carries meaning here, so it
 * comes from the semantic status set rather than the brand accent or the
 * per-platform brand colours (`oct-telegram`, `oct-yellow`) it used before:
 * connected = good, configured-but-not-connected = warn, unlinked = neutral.
 */
type Health = 'good' | 'warn' | 'off';

const healthText = (health: Health) =>
  cn(
    'text-oct-muted',
    health === 'good' && 'text-oct-good',
    health === 'warn' && 'text-oct-warn',
  );

const healthDot = (health: Health) =>
  cn(
    'h-1.5 w-1.5 shrink-0 rounded-full bg-oct-border-bright',
    health === 'good' && 'bg-oct-good animate-pulse-live',
    health === 'warn' && 'bg-oct-warn',
  );

/**
 * One line of the session readout: wide-tracked mono label on the left, mono
 * value on the right, with a status dot when the row reports a connection.
 * Kept as a local component so all four rows share one rhythm by construction.
 */
function StatRow({ label, value, health }: { label: string; value: string; health?: Health }) {
  return (
    <div className="flex items-baseline justify-between gap-comfy border-b border-oct-border/70 py-cozy last:border-b-0">
      <span className={cn(EYEBROW_CLASS, 'tracking-[0.16em]')}>{label}</span>
      <span className="flex items-center gap-snug">
        {health && <span className={healthDot(health)} />}
        <span className={cn('type-data text-sm', health ? healthText(health) : 'text-oct-text')}>
          {value}
        </span>
      </span>
    </div>
  );
}

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
      {/* Brand band + session readout. The band is deliberately short: the home
          is a command surface, so the modules belong above the fold, not the
          slogan. The readout sits in the band's right half, which was dead
          space, and replaces the status card that used to trail the page. */}
      <section className="relative overflow-hidden border-b border-oct-border bg-gradient-to-br from-oct-flame to-oct-accent px-roomy py-section text-black shadow-oct-soft sm:px-gutter">
        <div className="relative mx-auto flex max-w-7xl flex-col gap-section lg:flex-row lg:items-center lg:justify-between lg:gap-gutter">
          <div className="min-w-0">
            <p className="type-caption mb-cozy font-mono uppercase tracking-[0.24em] opacity-80">
              [ Console ]
            </p>
            <h1 className="font-display text-[clamp(1.625rem,4vw,2.75rem)] leading-[0.95] tracking-tight">
              PICK A MODULE.
              <span className="block">GET TO WORK.</span>
            </h1>
            <p className="type-label mt-comfy max-w-md font-mono font-normal leading-relaxed opacity-80">
              Feed needs a Discord token in Settings — it never leaves your browser.
            </p>
          </div>

          {/* Terminal readout on the brand band. `bg-oct-bg` rather than a
              hardcoded black so it inverts correctly on the cream theme. */}
          <div className="w-full shrink-0 rounded-oct border border-oct-border bg-oct-bg/95 px-roomy py-comfy shadow-oct-soft-lg lg:w-[22rem]">
            <p className={cn(EYEBROW_CLASS, 'mb-cozy tracking-[0.2em]')}>Session</p>
            <StatRow label="Account" value={isAuthenticated ? 'SIGNED_IN' : 'GUEST'} />
            <StatRow
              label="Discord"
              health={discordHealth}
              value={discordConfigured ? (connected ? 'CONNECTED' : 'CONNECTING') : 'NOT_LINKED'}
            />
            <StatRow
              label="Telegram"
              health={telegramHealth}
              value={
                telegramConfigured
                  ? telegramConnected
                    ? 'CONNECTED'
                    : 'DISCONNECTED'
                  : 'NOT_LINKED'
              }
            />
            <StatRow label="Rooms" value={String(rooms.length)} />
          </div>
        </div>
      </section>

      <section className="px-roomy pb-gutter pt-section sm:px-gutter">
        {/* Stagger parent. Each card below opts in with `variants={fadeInUp}`. */}
        <MotionFeatures>
          <m.div variants={stagger} initial="hidden" animate="visible" className="mx-auto max-w-7xl">
            {/* Renders nothing once the user has reached a first signal (or dismissed it). */}
            <ActivationChecklist />

            {/* Eyebrow + hairline rule: the section marker the page was missing,
                and the thing that makes the grid below read as one block. */}
            <div className="mb-comfy flex items-center gap-comfy">
              <p className={cn(EYEBROW_CLASS, 'shrink-0 tracking-[0.2em]')}>Modules</p>
              <span className="h-px flex-1 bg-oct-border" />
            </div>

            <div className="grid grid-cols-1 gap-comfy md:grid-cols-2 xl:grid-cols-3">
              {modules.map((mod) => {
                const Icon = mod.icon;
                const isLive =
                  mod.liveKey === 'discord' ? discordConfigured && connected :
                  mod.liveKey === 'auth' ? isAuthenticated :
                  false;

                return (
                  <m.div
                    key={mod.title}
                    variants={fadeInUp}
                    transition={enter}
                    className={cn('flex', mod.featured && 'md:col-span-2')}
                  >
                    <Link
                      to={mod.to}
                      className={cn(
                        'group oct-card flex flex-1 flex-col p-roomy transition-all duration-fast hover:-translate-y-0.5 hover:border-oct-border-bright hover:shadow-oct-soft-lg',
                        mod.featured && 'border-oct-accent/40 hover:border-oct-accent/70',
                      )}
                    >
                      <div className="mb-cozy flex items-center gap-comfy">
                        <span className={cn(EYEBROW_CLASS, 'tabular-nums')}>{mod.num}</span>
                        {/* Live = a healthy connection, so it is `oct-good`, not the accent. */}
                        {isLive && (
                          <span className="type-caption flex items-center gap-snug font-mono uppercase tracking-[0.12em] text-oct-good">
                            <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-oct-good" />
                            Live
                          </span>
                        )}
                        <span className="ml-auto flex h-8 w-8 items-center justify-center rounded-oct border border-oct-border bg-oct-surface-raised/60 text-oct-muted transition-colors duration-fast group-hover:border-oct-accent/50 group-hover:text-oct-accent">
                          <Icon size={16} />
                        </span>
                      </div>
                      {/* The featured card is twice as wide, so its title and
                          blurb sit side by side rather than stacking — stacking
                          left the right half of the card empty and kept the
                          measure of the blurb no shorter. */}
                      <div
                        className={cn(
                          'flex flex-1 flex-col',
                          mod.featured && 'md:flex-row md:items-baseline md:gap-roomy',
                        )}
                      >
                        <h2
                          className={cn(
                            'mb-tight font-display tracking-tight text-oct-text',
                            mod.featured ? 'text-3xl md:mb-0 md:shrink-0' : 'text-2xl',
                          )}
                        >
                          {mod.title}
                        </h2>
                        <p className="type-body flex-1 leading-snug text-oct-muted">{mod.desc}</p>
                      </div>
                      <div className="mt-comfy border-t border-oct-border pt-cozy">
                        <span className="type-caption inline-flex items-center gap-snug font-mono uppercase tracking-[0.14em] text-oct-accent transition-transform duration-fast group-hover:translate-x-1">
                          Enter <ArrowRight size={14} />
                        </span>
                      </div>
                    </Link>
                  </m.div>
                );
              })}
            </div>

            {/* Quick start, as a full-width rail rather than a half-width card
                with an empty middle. Un-connected users go to Feed, not
                Settings: the demo feed and the token form both live on Feed;
                Settings only has the form. */}
            <m.div
              variants={fadeInUp}
              transition={enter}
              className="oct-card mt-comfy flex flex-col gap-comfy p-roomy sm:flex-row sm:items-center sm:justify-between sm:gap-gutter"
            >
              <div className="min-w-0">
                <p className={cn(EYEBROW_CLASS, 'mb-tight tracking-[0.2em]')}>Quick start</p>
                <p className="type-body leading-snug text-oct-muted">
                  {discordConfigured
                    ? 'Open Feed to stream channels, or configure rooms in Settings.'
                    : 'Open Feed to watch the demo feed — no token needed. Connect Discord there when you want your own servers.'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-roomy">
                <a
                  href={USER_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="type-caption font-mono uppercase tracking-[0.12em] text-oct-muted underline underline-offset-4 transition-colors duration-fast hover:text-oct-text"
                >
                  User guide
                </a>
                <Link
                  to={routes.feed}
                  className="oct-btn-primary type-label px-roomy py-cozy font-mono uppercase tracking-[0.12em]"
                >
                  Open Feed
                  <ArrowRight size={14} />
                </Link>
              </div>
            </m.div>
          </m.div>
        </MotionFeatures>
      </section>
    </div>
  );
}
