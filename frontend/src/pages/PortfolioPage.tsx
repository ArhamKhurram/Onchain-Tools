import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import PortfolioDashboard from '../components/portfolio/PortfolioDashboard';
import JournalView from '../components/journal/JournalView';
import ConsoleSubnav from '../components/console/ConsoleSubnav';

type PortfolioView = 'dashboard' | 'journal';

// Same tab pattern as CallersPage (Contracts/Radar/Revival): the view rides a
// query param so tabs deep-link and survive refresh. Portfolio (Birdeye
// holdings of My Wallets) and Journal (own-wallet trade history via Helius)
// are siblings — both are about the operator's OWN money.
const PORTFOLIO_TABS = [
  { id: 'dashboard' as const, label: 'Dashboard' },
  { id: 'journal' as const, label: 'Journal' },
];

export default function PortfolioPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo<PortfolioView>(
    () => (searchParams.get('view') === 'journal' ? 'journal' : 'dashboard'),
    [searchParams],
  );

  const setView = (next: PortfolioView) => {
    setSearchParams(next === 'dashboard' ? {} : { view: next }, { replace: true });
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <ConsoleSubnav tabs={PORTFOLIO_TABS} active={view} onChange={setView} />
      <div className="flex-1 min-h-0">
        {view === 'journal' ? <JournalView /> : <PortfolioDashboard />}
      </div>
    </div>
  );
}
