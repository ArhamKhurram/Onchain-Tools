import { useMemo } from 'react';
import { RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import type { useTrackedPumpWallets } from '../../hooks/useTrackedPumpWallets';
import { usePumpConnection } from '../../hooks/usePumpConnection';
import { usePumpLeaderboard } from '../../hooks/usePumpLeaderboard';
import PumpConnectPanel from './PumpConnectPanel';
import PumpLeaderboard from './PumpLeaderboard';

interface PumpLeaderboardTabProps {
  /** Owned by PumpfunPage and shared across sub-tabs (same pattern FomoPage uses). */
  tracking: ReturnType<typeof useTrackedPumpWallets>;
}

// The Leaderboard sub-tab's brain: it owns the connection and the leaderboard
// fetch and decides which of the four states to render. The tracked-wallet list is
// owned one level up (PumpfunPage) so that tracking a trader here shows up on the
// Traders tab without a reload — exactly how FomoPage threads useFomoTracking into
// its leaderboard.
//
// State machine:
//   status loading            -> spinner
//   status fetch failed        -> retry notice (not a false "connect" prompt)
//   disconnected / unknown     -> connect panel
//   reconnect  OR  leaderboard
//     returned 401/403         -> reconnect panel
//   connected                  -> status strip + the ranked list
export default function PumpLeaderboardTab({ tracking }: PumpLeaderboardTabProps) {
  const { summary, loading, statusError, refresh, connect, disconnect } = usePumpConnection();
  const connected = summary.state === 'connected';
  const board = usePumpLeaderboard(connected);

  const trackedAddresses = useMemo(
    () => new Set(tracking.wallets.map((w) => w.address)),
    [tracking.wallets],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-oct-bg">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // The status route itself faulted (vs. a clean "not connected"): offer a retry
  // rather than sending the operator to paste a token that may already be valid.
  if (statusError && summary.state === 'unknown') {
    return (
      <div className="flex items-center justify-center h-full p-6 bg-oct-bg">
        <div className="max-w-sm text-center">
          <p className="font-mono text-[11px] leading-relaxed text-oct-muted mb-4">{statusError}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-cockpit text-[10px] font-mono font-bold uppercase border-2 border-oct-accent text-oct-accent hover:bg-oct-accent hover:text-white transition-colors"
          >
            <RefreshCw size={11} />
            retry
          </button>
        </div>
      </div>
    );
  }

  // A 401/403 from the leaderboard means the session was rejected upstream even if
  // the status route still reported it connected — flip to reconnect.
  if (summary.state === 'reconnect' || board.authExpired) {
    return <PumpConnectPanel mode="reconnect" onConnect={connect} />;
  }

  if (!connected) {
    return <PumpConnectPanel mode="connect" onConnect={connect} />;
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b-2 border-black bg-oct-surface/60">
        <ShieldCheck size={13} className="text-oct-green shrink-0" strokeWidth={2.5} />
        <span className="font-mono text-[10px] text-oct-muted">
          <span className="text-oct-green font-bold">Connected</span>
          {summary.daysLeft != null && (
            <>
              {' · '}
              expires in <span className="text-oct-text">{summary.daysLeft}</span>d
            </>
          )}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void disconnect()}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-cockpit text-[9px] font-mono font-bold uppercase border-2 border-oct-border text-oct-muted hover:text-oct-flame hover:border-oct-flame/60 transition-colors"
          title="Disconnect pump.fun"
        >
          <Unplug size={11} />
          Disconnect
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <PumpLeaderboard board={board} trackedAddresses={trackedAddresses} onTrack={tracking.track} />
      </div>
    </div>
  );
}
