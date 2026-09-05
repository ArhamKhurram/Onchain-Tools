import { Wallet } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import WalletTracker from '../components/wallets/WalletTracker';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import FullPageSpinner from '../components/common/FullPageSpinner';
import { fadeInUp, m, MotionFeatures, useTransition } from '../lib/motion';
import { routes } from '../lib/routes';

// The tracked-wallet directory: on-chain addresses you watch (useTrackedWallets).
// Formerly the "Wallets" page, which also held My Wallets (now managed in
// Portfolio) and the FOMO tabs (now the FOMO section) — so it's single-purpose
// and tab-less now.
export default function DirectoryPage() {
  const { isAuthenticated, ready, userId } = useAuthSession();
  // Hook before the early returns — React needs it called on every render.
  // Resolves to an instant transition under `prefers-reduced-motion`.
  const enter = useTransition('snappy');

  if (!ready) {
    return <FullPageSpinner />;
  }

  if (!isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={Wallet}
        eyebrow="[ DIRECTORY ]"
        title="Sign in to track wallets"
        description="Your wallet directory — the on-chain addresses you watch for activity — is private, scoped to your account only."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  if (!userId) {
    return (
      <div className="flex items-center justify-center h-full p-section bg-oct-bg">
        <p className="font-mono type-body text-oct-muted">Unable to load account. Try signing in again.</p>
      </div>
    );
  }

  // Page-container entrance only. The table inside is user-driven rather than
  // streamed, but it is still a list — animating the container once on route
  // entry gives the rise without touching a single row (lib/motion.ts rule).
  // Motion loads with this lazy route chunk, so it stays off the boot path.
  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <MotionFeatures>
        <m.div
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          transition={enter}
          className="flex-1 min-h-0"
        >
          <WalletTracker userId={userId} />
        </m.div>
      </MotionFeatures>
    </div>
  );
}
