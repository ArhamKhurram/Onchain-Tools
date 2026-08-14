import { useTrackedPumpWallets } from '../../hooks/useTrackedPumpWallets';
import PumpLeaderboardTab from '../pumpfun/PumpLeaderboardTab';

// PumpLeaderboardTab expects the tracked-wallet list threaded in from its parent
// (PumpfunPage owns it so tracking survives a sub-tab hop). Inside a workspace panel
// there is no such parent, so this thin wrapper owns the hook locally — exactly how
// WorkspaceFomoLeaderboard wraps FomoLeaderboard.
export default function WorkspacePumpLeaderboard() {
  const tracking = useTrackedPumpWallets();
  return <PumpLeaderboardTab tracking={tracking} />;
}
