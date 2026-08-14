import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTrackedPumpWallets } from '../hooks/useTrackedPumpWallets';
import { usePumpTrending } from '../hooks/usePumpTrending';
import ConsoleSubnav from '../components/console/ConsoleSubnav';
import PumpTrackedWallets from '../components/pumpfun/PumpTrackedWallets';
import PumpTokenPanel from '../components/pumpfun/PumpTokenPanel';
import PumpTrendingPanel from '../components/pumpfun/PumpTrendingPanel';
import PumpLeaderboardTab from '../components/pumpfun/PumpLeaderboardTab';
import PumpTopCallersTab from '../components/pumpfun/PumpTopCallersTab';
import PumpCallersTab from '../components/pumpfun/PumpCallersTab';
import { DEFAULT_PUMP_VIEW, PUMP_TABS, parsePumpView, type PumpView } from '../lib/pumpViews';

// The pump.fun tab: read-only windows onto a THIRD PARTY's data (coin-communities
// callouts + profile-api trades/PnL), plus the Leaderboard tab, which is the one
// per-user surface — it is served with the operator's OWN pump.fun login. Unlike
// the Sniper page there is no page-level auth gate: the public tabs need none, and
// the Leaderboard gates itself on a connected session (PumpLeaderboardTab), so the
// page stays a thin subnav.
//
// The tracked-wallet list and the trending fetch are owned HERE and passed down,
// the way SniperPage/FomoPage own their hooks: tracking a wallet on the Traders or
// Leaderboard tab must survive a hop to another tab and back without losing the
// list or refetching, and the localStorage list has a single source of truth.
// The view registry lives in lib/pumpViews.ts so the sub-tab set is unit-testable.

export default function PumpfunPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo(() => parsePumpView(searchParams.get('view')), [searchParams]);

  const tracking = useTrackedPumpWallets();
  const trending = usePumpTrending();

  const setView = (next: PumpView) => {
    setSearchParams(next === DEFAULT_PUMP_VIEW ? {} : { view: next }, { replace: true });
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <ConsoleSubnav tabs={[...PUMP_TABS]} active={view} onChange={setView} />
      <div className="flex-1 min-h-0">
        {view === 'traders' ? (
          <PumpTrackedWallets tracking={tracking} />
        ) : view === 'token' ? (
          <PumpTokenPanel />
        ) : view === 'trending' ? (
          <PumpTrendingPanel trending={trending} />
        ) : view === 'top-callers' ? (
          <PumpTopCallersTab />
        ) : view === 'following' ? (
          <PumpCallersTab />
        ) : (
          <PumpLeaderboardTab tracking={tracking} />
        )}
      </div>
    </div>
  );
}
