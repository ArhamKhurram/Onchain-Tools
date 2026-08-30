import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import type { Alert, ContractEntry } from '../types';
import type { FomoTrade } from '../types/fomo';
import { playContractAlertSound } from '../utils/notificationSound';
import { notifyConvergencePushover } from '../utils/convergencePushover';
import {
  convergenceAlertMessage,
  convergenceAlertReason,
  convergenceKey,
  findConvergenceForContract,
  findConvergenceForTrade,
  getSignalConvergenceWindowMs,
} from '../utils/signalConvergence';

let alertSeq = 0;
const seenKeys = new Set<string>();

function fireConvergenceAlert(
  contract: ContractEntry,
  trade: FomoTrade,
  addAlert: (alert: Alert) => void,
  config: ReturnType<typeof useAppStore.getState>['config'],
) {
  const key = convergenceKey(contract, trade);
  if (seenKeys.has(key)) return;
  seenKeys.add(key);

  const windowMinutes = config?.signalConvergenceWindowMinutes ?? 30;
  const alert: Alert = {
    id: `convergence-${++alertSeq}`,
    type: 'signal_convergence',
    message: convergenceAlertMessage(contract, trade, windowMinutes),
    reason: convergenceAlertReason(contract, trade),
    timestamp: Date.now(),
  };
  addAlert(alert);

  if (config?.messageSounds) {
    playContractAlertSound(config.soundSettings?.contractAlert);
  }

  if (config?.pushover?.enabled && config.pushover.triggers?.signalConvergence) {
    const trader = trade.displayName || trade.fomoHandle || 'Tracked trader';
    void notifyConvergencePushover({
      contractAddress: contract.address,
      tokenSymbol: trade.tokenSymbol ?? contract.tokenSymbol,
      traderName: trader,
      channelName: contract.channelName,
      evmChain: contract.evmChain,
    });
  }
}

/**
 * Cross-source signal convergence: when a contract appears in the Discord/Telegram
 * feed and a tracked FOMO user buys the same token within the time window, fire
 * a high-priority in-app alert (and optional sound / Pushover).
 */
export function useSignalConvergence() {
  const addAlert = useAppStore((s) => s.addAlert);
  const prevFomoLen = useRef(0);
  const prevContractLen = useRef(0);

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state) => {
      const { fomoTrades, contracts, config } = state;
      const windowMs = getSignalConvergenceWindowMs(config);

      if (fomoTrades.length > prevFomoLen.current) {
        const trade = fomoTrades[0];
        const contract = findConvergenceForTrade(trade, contracts, windowMs);
        if (contract) {
          fireConvergenceAlert(contract, trade, addAlert, config);
        }
      }
      prevFomoLen.current = fomoTrades.length;

      if (contracts.length > prevContractLen.current) {
        const contract = contracts[0];
        const trade = findConvergenceForContract(contract, fomoTrades, windowMs);
        if (trade) {
          fireConvergenceAlert(contract, trade, addAlert, config);
        }
      }
      prevContractLen.current = contracts.length;
    });

    const initial = useAppStore.getState();
    prevFomoLen.current = initial.fomoTrades.length;
    prevContractLen.current = initial.contracts.length;

    return unsubscribe;
  }, [addAlert]);
}

// NOTE: the old per-row `useConvergenceForContract` hook was removed — the
// contract feed now resolves convergence once per fomoTrades change via
// `buildFomoBuyIndex` / `findConvergenceInIndex` (utils/signalConvergence.ts)
// and passes the matched trade down as a prop, so hundreds of rows don't each
// subscribe to (and rescan) the whole trades list.
