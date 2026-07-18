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
          <div className="w-14 h-14 rounded-cockpit border-2 border-black bg-oct-surface shadow-oct-hard flex items-center justify-center mx-auto mb-5">
            <TrendingUp size={28} strokeWidth={2} className="text-oct-accent" />
          </div>
          <h2 className="text-xl font-extrabold uppercase text-oct-text mb-2">Sign in for Callers</h2>
          <p className="text-sm text-oct-muted mb-6 leading-relaxed">
            Radar and Contract Feed use your personal detections from Discord/Telegram.
          </p>
          <Link
            to="/dashboard/login"
            className="brutal-btn-ghost px-5 py-2.5 text-sm"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <div className="shrink-0 flex items-center gap-1 px-4 py-2 border-b-2 border-black bg-oct-surface">
        <button
          type="button"
          onClick={() => setView('feed')}
          className={`px-3 py-1.5 text-sm font-bold uppercase tracking-wide rounded-cockpit border-2 transition-all duration-100 ${
            view === 'feed' ? 'text-white bg-oct-accent border-black shadow-oct-hard-sm' : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
          }`}
        >
          Contract Feed
        </button>
        <button
          type="button"
          onClick={() => setView('radar')}
          className={`px-3 py-1.5 text-sm font-bold uppercase tracking-wide rounded-cockpit border-2 transition-all duration-100 ${
            view === 'radar' ? 'text-white bg-oct-accent border-black shadow-oct-hard-sm' : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
          }`}
        >
          Radar
        </button>
      </div>
      {view === 'radar' ? <RadarTable /> : <ContractDashboard />}
    </div>
  );
}
