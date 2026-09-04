import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import PortfolioDashboard from '../components/portfolio/PortfolioDashboard';
import JournalView from '../components/journal/JournalView';
import ConsoleSubnav from '../components/console/ConsoleSubnav';
import { fadeInUp, m, MotionFeatures, useTransition } from '../lib/motion';

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
  const enter = useTransition('snappy');

  const setView = (next: PortfolioView) => {
    setSearchParams(next === 'dashboard' ? {} : { view: next }, { replace: true });
  };

  // Chrome-only motion: the page container rises once on route entry. Nothing
  // inside it animates — the holdings/activity rows re-render on every refresh
  // and are exactly the "stream" the motion policy keeps still. The provider is
  // mounted here, per surface, so the Motion runtime stays behind this lazy
  // route rather than on the boot path.
  return (
    <MotionFeatures>
      <m.div
        variants={fadeInUp}
        initial="hidden"
        animate="visible"
        transition={enter}
        className="h-full min-h-0 flex flex-col bg-oct-bg"
      >
        <ConsoleSubnav tabs={PORTFOLIO_TABS} active={view} onChange={setView} />
        <div className="flex-1 min-h-0">
          {view === 'journal' ? <JournalView /> : <PortfolioDashboard />}
        </div>
      </m.div>
    </MotionFeatures>
  );
}
