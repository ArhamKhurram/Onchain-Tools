import { useCallback, useEffect, useState } from 'react';
import {
  addTrackedWallet,
  normalizeTrackedList,
  removeTrackedWallet,
  TRACKED_WALLETS_STORAGE_KEY,
  type AddTrackedResult,
  type TrackedPumpWallet,
} from '../types/pumpfun';

/**
 * The tracked-trader list, persisted in localStorage (v1 — there is no backend
 * table yet, so tracking is per-browser, not per-Supabase-user; see the note in
 * types/pumpfun.ts). Owned by PumpfunPage and passed down so tracking a wallet on
 * one tab reflects on every other without a reload, the way FomoPage owns
 * useFomoTracking.
 *
 * The add/remove logic is the pure reducer in types/pumpfun.ts; this hook is only
 * the React + storage shell around it.
 */
function load(): TrackedPumpWallet[] {
  try {
    const raw = localStorage.getItem(TRACKED_WALLETS_STORAGE_KEY);
    if (!raw) return [];
    return normalizeTrackedList(JSON.parse(raw));
  } catch {
    return [];
  }
}

function persist(list: TrackedPumpWallet[]): void {
  try {
    localStorage.setItem(TRACKED_WALLETS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota or private-mode failure — the in-memory list still works this session.
  }
}

export function useTrackedPumpWallets() {
  const [wallets, setWallets] = useState<TrackedPumpWallet[]>(() => load());

  useEffect(() => {
    persist(wallets);
  }, [wallets]);

  const track = useCallback(
    (address: string): AddTrackedResult => {
      // Reduce against the current list synchronously so the caller gets a
      // truthful ok/duplicate/invalid answer to render inline; a functional
      // setState updater would force the result to be read from a stale closure.
      const result = addTrackedWallet(wallets, address);
      if (result.ok) setWallets(result.list);
      return result;
    },
    [wallets],
  );

  const untrack = useCallback((address: string) => {
    setWallets((prev) => removeTrackedWallet(prev, address));
  }, []);

  return { wallets, track, untrack };
}
