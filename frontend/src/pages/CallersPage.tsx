import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import ContractDashboard from '../components/ContractDashboard';
import RadarTable from '../components/callers/RadarTable';

type CallersView = 'feed' | 'radar';

export default function CallersPage() {
  const { isAuthenticated, ready } = useAuthSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo<CallersView>(() => {
    const q = searchParams.get('view');
    return q === 'radar' ? 'radar' : 'feed';
  }, [searchParams]);

  const setView = (next: CallersView) => {
    setSearchParams(next === 'feed' ? {} : { view: next }, { replace: true });
  };

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-full bg-oct-bg">
        <div className="w-6 h-6 border-2 border-oct-live border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full p-6 bg-oct-bg">
        <div className="max-w-md text-center">
          <div className="w-14 h-14 rounded-cockpit border border-oct-border flex items-center justify-center mx-auto mb-5">
            <TrendingUp size={28} strokeWidth={1.5} className="text-oct-live" />
          </div>
          <h2 className="text-xl font-semibold text-oct-text mb-2">Sign in for Callers</h2>
          <p className="text-sm text-oct-muted mb-6 leading-relaxed">
            Radar and Contract Feed use your personal detections from Discord/Telegram.
          </p>
          <Link
            to="/dashboard/login"
            className="inline-flex px-5 py-2.5 border border-oct-border rounded-cockpit text-sm font-medium text-oct-text hover:border-oct-muted transition-colors"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <div className="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-oct-border bg-oct-surface">
        <button
          type="button"
          onClick={() => setView('feed')}
          className={`px-3 py-1.5 text-sm font-medium rounded-cockpit transition-colors ${
            view === 'feed' ? 'text-oct-live bg-oct-live-dim' : 'text-oct-muted hover:text-oct-text'
          }`}
        >
          Contract Feed
        </button>
        <button
          type="button"
          onClick={() => setView('radar')}
          className={`px-3 py-1.5 text-sm font-medium rounded-cockpit transition-colors ${
            view === 'radar' ? 'text-oct-live bg-oct-live-dim' : 'text-oct-muted hover:text-oct-text'
          }`}
        >
          Radar
        </button>
      </div>
      {view === 'radar' ? <RadarTable /> : <ContractDashboard />}
    </div>
  );
}
