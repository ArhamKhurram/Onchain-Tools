import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import type { Alert } from '../types';
import { playContractAlertSound } from '../utils/notificationSound';
import {
  convergenceAlertMessage,
  convergenceAlertReason,
  convergenceKey,
  findConvergenceForContract,
  findConvergenceForTrade,
} from '../utils/signalConvergence';

let alertSeq = 0;
const seenKeys = new Set<string>();

/**
 * Cross-source signal convergence: when a contract appears in the Discord/Telegram
 * feed and a tracked FOMO user buys the same token within the time window, fire
 * a high-priority in-app alert (and optional sound).
 */
export function useSignalConvergence() {
  const addAlert = useAppStore((s) => s.addAlert);
  const prevFomoLen = useRef(0);
  const prevContractLen = useRef(0);

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state) => {
      const { fomoTrades, contracts, config } = state;

      if (fomoTrades.length > prevFomoLen.current) {
        const trade = fomoTrades[0];
        const contract = findConvergenceForTrade(trade, contracts);
        if (contract) {
          const key = convergenceKey(contract, trade);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            const alert: Alert = {
              id: `convergence-${++alertSeq}`,
              type: 'signal_convergence',
              message: convergenceAlertMessage(contract, trade),
              reason: convergenceAlertReason(contract, trade),
              timestamp: Date.now(),
            };
            addAlert(alert);
            if (config?.messageSounds) {
              playContractAlertSound(config.soundSettings?.contractAlert);
            }
          }
        }
      }
      prevFomoLen.current = fomoTrades.length;

      if (contracts.length > prevContractLen.current) {
        const contract = contracts[0];
        const trade = findConvergenceForContract(contract, fomoTrades);
        if (trade) {
          const key = convergenceKey(contract, trade);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            const alert: Alert = {
              id: `convergence-${++alertSeq}`,
              type: 'signal_convergence',
              message: convergenceAlertMessage(contract, trade),
              reason: convergenceAlertReason(contract, trade),
              timestamp: Date.now(),
            };
            addAlert(alert);
            if (config?.messageSounds) {
              playContractAlertSound(config.soundSettings?.contractAlert);
            }
          }
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
