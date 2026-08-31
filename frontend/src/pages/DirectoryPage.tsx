import { Wallet } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import WalletTracker from '../components/wallets/WalletTracker';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import FullPageSpinner from '../components/common/FullPageSpinner';
import { routes } from '../lib/routes';

// The tracked-wallet directory: on-chain addresses you watch (useTrackedWallets).
// Formerly the "Wallets" page, which also held My Wallets (now managed in
// Portfolio) and the FOMO tabs (now the FOMO section) — so it's single-purpose
// and tab-less now.
export default function DirectoryPage() {
  const { isAuthenticated, ready, userId } = useAuthSession();

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
      <div className="flex items-center justify-center h-full p-6 bg-oct-bg">
        <p className="font-mono text-sm text-oct-muted">Unable to load account. Try signing in again.</p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <div className="flex-1 min-h-0">
        <WalletTracker userId={userId} />
      </div>
    </div>
  );
}
