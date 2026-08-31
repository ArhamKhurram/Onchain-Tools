import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Crosshair } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useSniperFires } from '../hooks/useSniperFires';
import { useSniperRules } from '../hooks/useSniperRules';
import { useSniperStatus } from '../hooks/useSniperStatus';
import { useSniperVenues } from '../hooks/useSniperVenues';
import { useSniperWallets } from '../hooks/useSniperWallets';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import ConsoleSubnav from '../components/console/ConsoleSubnav';
import SniperFiresTable from '../components/sniper/SniperFiresTable';
import SniperRulesTable from '../components/sniper/SniperRulesTable';
import SniperStatusBar from '../components/sniper/SniperStatusBar';
import SniperWalletsTable from '../components/sniper/SniperWalletsTable';
import TriggerRealityNotice from '../components/sniper/TriggerRealityNotice';
import VenueConnectPanel from '../components/sniper/VenueConnectPanel';
import FullPageSpinner from '../components/common/FullPageSpinner';
import { routes } from '../lib/routes';

// The sniper console: a control plane and a record, not a trigger engine. The
// automatic tweet -> buy loop runs inside Slotshark and never calls back into
// OCT, which is why TriggerRealityNotice sits above the subnav on every tab and
// cannot be dismissed.
//
// Every hook is owned HERE and passed down, the way FomoPage owns
// useFomoTracking: connecting a venue on the Venues tab has to un-block the
// Rules tab's fire button immediately, and adding a wallet has to appear in the
// rule form's wallet picker without a reload.
type SniperView = 'rules' | 'fires' | 'wallets' | 'venues';

const SNIPER_TABS = [
  { id: 'rules' as const, label: 'Rules' },
  { id: 'fires' as const, label: 'Fires' },
  { id: 'wallets' as const, label: 'Wallets' },
  { id: 'venues' as const, label: 'Venues' },
];

function parseView(raw: string | null): SniperView {
  if (raw === 'fires' || raw === 'wallets' || raw === 'venues') return raw;
  return 'rules';
}

export default function SniperPage() {
  const { isAuthenticated, ready, userId } = useAuthSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo(() => parseView(searchParams.get('view')), [searchParams]);

  const status = useSniperStatus();
  const wallets = useSniperWallets();
  const rules = useSniperRules();
  const fires = useSniperFires();
  const venues = useSniperVenues(userId);

  const setView = (next: SniperView) => {
    setSearchParams(next === 'rules' ? {} : { view: next }, { replace: true });
  };

  if (!ready) {
    return <FullPageSpinner />;
  }

  // Gated on `isAuthenticated` ONLY, deliberately not on `userId` as FomoPage is.
  // In local mode useAuthSession hardcodes isAuthenticated:true with an undefined
  // userId, and local mode is exactly where SLOTSHARK_API_TOKEN lives and where
  // the manual test buy gets proven — a !userId gate would lock the operator out
  // of their own machine. The hosted-only surface is the venue connect panel,
  // which gates on isHostedMode internally.
  if (!isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={Crosshair}
        eyebrow="[ SNIPER ]"
        title="Sign in for the sniper"
        description="Connect your Slotshark account, set caps, and fire a test buy — dry-run first."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <TriggerRealityNotice />
      <SniperStatusBar
        status={status.status}
        error={status.error}
        onSetKill={(on) => status.setKill(on)}
        onRefresh={() => void status.refresh()}
      />
      <ConsoleSubnav tabs={SNIPER_TABS} active={view} onChange={setView} />
      <div className="flex-1 min-h-0">
        {view === 'rules' ? (
          <SniperRulesTable
            rules={rules}
            wallets={wallets.wallets}
            processDryRun={status.status?.processDryRun ?? false}
            killed={status.status?.kill.on ?? false}
          />
        ) : view === 'fires' ? (
          <SniperFiresTable fires={fires} />
        ) : view === 'wallets' ? (
          <SniperWalletsTable wallets={wallets} />
        ) : (
          <VenueConnectPanel venues={venues} status={status.status} />
        )}
      </div>
    </div>
  );
}
