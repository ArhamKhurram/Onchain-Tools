import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import ContractDashboard from '../components/ContractDashboard';
import RadarTable from '../components/callers/RadarTable';
import RevivalLog from '../components/callers/RevivalLog';
import PriceAlerts from '../components/callers/PriceAlerts';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import ConsoleSubnav from '../components/console/ConsoleSubnav';
import { routes } from '../lib/routes';

type CallersView = 'feed' | 'radar' | 'revival' | 'alerts';

const CALLERS_TABS = [
  { id: 'feed' as const, label: 'Contracts' },
  { id: 'radar' as const, label: 'Radar' },
  { id: 'revival' as const, label: 'Revival' },
  // Operator-SET levels. Deliberately its own tab next to Revival, not part of
  // it: revival detects, this one only reports the crossing of a number the
  // operator typed. Signals stay independent (CLAUDE.md).
  { id: 'alerts' as const, label: 'Alerts' },
];

export default function CallersPage() {
  const { isAuthenticated, ready } = useAuthSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo<CallersView>(() => {
    const q = searchParams.get('view');
    return q === 'radar' || q === 'revival' || q === 'alerts' ? q : 'feed';
  }, [searchParams]);

  const setView = (next: CallersView) => {
    setSearchParams(next === 'feed' ? {} : { view: next }, { replace: true });
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
        icon={TrendingUp}
        eyebrow="[ CALL ]"
        title="Sign in for callers"
        description="Radar and contract feed use your personal detections from Discord and Telegram."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <ConsoleSubnav tabs={CALLERS_TABS} active={view} onChange={setView} />
      {view === 'radar' ? (
        <RadarTable />
      ) : view === 'revival' ? (
        <RevivalLog />
      ) : view === 'alerts' ? (
        <PriceAlerts />
      ) : (
        <ContractDashboard />
      )}
    </div>
  );
}
