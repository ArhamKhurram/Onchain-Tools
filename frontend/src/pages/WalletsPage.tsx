import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import WalletTracker from '../components/wallets/WalletTracker';
import FomoTracker from '../components/fomo/FomoTracker';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import ConsoleSubnav from '../components/console/ConsoleSubnav';
import { routes } from '../lib/routes';

type WalletsView = 'wallets' | 'fomo';

const WALLETS_TABS = [
  { id: 'wallets' as const, label: 'Wallets' },
  { id: 'fomo' as const, label: 'FOMO Tracking' },
];

export default function WalletsPage() {
  const { isAuthenticated, ready, userId } = useAuthSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo<WalletsView>(() => {
    return searchParams.get('view') === 'fomo' ? 'fomo' : 'wallets';
  }, [searchParams]);

  const setView = (next: WalletsView) => {
    setSearchParams(next === 'wallets' ? {} : { view: next }, { replace: true });
  };

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-full bg-oct-bg">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={Wallet}
        eyebrow="[ TRACK ]"
        title="Sign in to track wallets"
        description="Your tracked wallets and FOMO traders are private — scoped to your account only."
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
      <ConsoleSubnav tabs={WALLETS_TABS} active={view} onChange={setView} />
      <div className="flex-1 min-h-0">
        {view === 'fomo' ? <FomoTracker userId={userId} /> : <WalletTracker userId={userId} />}
      </div>
    </div>
  );
}
