import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import WalletTracker from '../components/wallets/WalletTracker';
import FomoTracker from '../components/fomo/FomoTracker';

type WalletsView = 'wallets' | 'fomo';

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
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="max-w-md text-center">
          <div className="w-14 h-14 rounded-cockpit border-2 border-black bg-oct-surface shadow-oct-hard flex items-center justify-center mx-auto mb-5">
            <Wallet size={28} strokeWidth={2} className="text-oct-accent" />
          </div>
          <h2 className="text-xl font-extrabold uppercase text-oct-text mb-2">Sign in to track wallets</h2>
          <p className="text-sm text-oct-muted mb-6 leading-relaxed">
            Your tracked wallets and FOMO traders are private — scoped to your account only.
          </p>
          <Link to="/dashboard/login" className="brutal-btn-ghost px-5 py-2.5 text-sm">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <p className="text-sm text-oct-muted">Unable to load account. Try signing in again.</p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <div className="shrink-0 flex items-center gap-1 px-4 py-2 border-b-2 border-black bg-oct-surface">
        <button
          type="button"
          onClick={() => setView('wallets')}
          className={`px-3 py-1.5 text-sm font-bold uppercase tracking-wide rounded-cockpit border-2 transition-all duration-100 ${
            view === 'wallets'
              ? 'text-white bg-oct-accent border-black shadow-oct-hard-sm'
              : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
          }`}
        >
          Wallets
        </button>
        <button
          type="button"
          onClick={() => setView('fomo')}
          className={`px-3 py-1.5 text-sm font-bold uppercase tracking-wide rounded-cockpit border-2 transition-all duration-100 ${
            view === 'fomo'
              ? 'text-white bg-oct-accent border-black shadow-oct-hard-sm'
              : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
          }`}
        >
          FOMO Tracking
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'fomo' ? <FomoTracker /> : <WalletTracker userId={userId} />}
      </div>
    </div>
  );
}
