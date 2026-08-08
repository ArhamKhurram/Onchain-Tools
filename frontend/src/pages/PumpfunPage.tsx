import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTrackedPumpWallets } from '../hooks/useTrackedPumpWallets';
import { usePumpTrending } from '../hooks/usePumpTrending';
import ConsoleSubnav from '../components/console/ConsoleSubnav';
import PumpTrackedWallets from '../components/pumpfun/PumpTrackedWallets';
import PumpTokenPanel from '../components/pumpfun/PumpTokenPanel';
import PumpTrendingPanel from '../components/pumpfun/PumpTrendingPanel';

// The pump.fun tab: read-only windows onto a THIRD PARTY's data (coin-communities
// callouts + profile-api trades/PnL). Unlike the Sniper page there is no auth
// gate and no status bar — nothing here spends and everything is public, so the
// page renders straight into the subnav (the recon relaxation: Pump.fun data is
// public, so skip the auth gate entirely).
//
// The tracked-wallet list and the trending fetch are owned HERE and passed down,
// the way SniperPage/FomoPage own their hooks: tracking a wallet on the Traders
// tab must survive a hop to Trending and back without losing the list or
// refetching, and the localStorage list has a single source of truth.
type PumpView = 'traders' | 'token' | 'trending';

const PUMP_TABS = [
  { id: 'traders' as const, label: 'Traders' },
  { id: 'token' as const, label: 'Token' },
  { id: 'trending' as const, label: 'Trending' },
];

function parseView(raw: string | null): PumpView {
  if (raw === 'token' || raw === 'trending') return raw;
  return 'traders';
}

export default function PumpfunPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo(() => parseView(searchParams.get('view')), [searchParams]);

  const tracking = useTrackedPumpWallets();
  const trending = usePumpTrending();

  const setView = (next: PumpView) => {
    setSearchParams(next === 'traders' ? {} : { view: next }, { replace: true });
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <ConsoleSubnav tabs={PUMP_TABS} active={view} onChange={setView} />
      <div className="flex-1 min-h-0">
        {view === 'traders' ? (
          <PumpTrackedWallets tracking={tracking} />
        ) : view === 'token' ? (
          <PumpTokenPanel />
        ) : (
          <PumpTrendingPanel trending={trending} />
        )}
      </div>
    </div>
  );
}
