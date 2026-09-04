// The Radar's refresh machinery: the per-row refresh, the top-40 bulk refresh
// behind the toolbar button, and the once-a-minute tick. Lifted out of
// RadarTable.tsx unchanged so the table is left with derivation + render.
//
// The `liveMc` map itself stays in RadarTable (passed in as its setter): the
// sorted rows depend on it and the refreshers depend on the sorted rows, so
// the state has to sit above both. Only the machinery moves.
//
// `refreshOne` is reference-stable on purpose — it is handed to every
// memoized RadarTableRow, and a new identity would re-render all ~600 of
// them. Its only dep is a useState setter, which React guarantees stable.
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useAppStore } from '../../stores/appStore';
import { refreshTokenPeak } from '../../hooks/useCallerQuality';
import { applyMetadataToStore, fetchMcNow, fetchTokenMetadata } from './radarApi';
import type { LiveMc, RadarRow } from './radarRows';
import type { RadarWindowFilter } from './radarSort';

export interface RadarLiveMcRefresh {
  /** True while the toolbar's bulk refresh is in flight. */
  refreshing: boolean;
  /** Lower-cased address of the row whose own refresh is in flight, if any. */
  refreshingRow: string | null;
  /**
   * Bumped once a minute so memoized rows refresh their relative "ago" text
   * even when nothing else about them changed.
   */
  agoTick: number;
  refreshOne: (address: string, evmChain?: string) => Promise<void>;
  refreshAll: () => Promise<void>;
}

export function useRadarLiveMc(
  rows: RadarRow[],
  windowFilter: RadarWindowFilter,
  setLiveMc: Dispatch<SetStateAction<Record<string, LiveMc>>>,
): RadarLiveMcRefresh {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);
  const [agoTick, setAgoTick] = useState(0);

  const refreshOne = useCallback(async (address: string, evmChain?: string) => {
    setRefreshingRow(address.toLowerCase());
    try {
      const [mc, meta] = await Promise.all([
        fetchMcNow(address),
        // Chains read at call time (not closed over) so this callback stays
        // reference-stable and memoized rows never re-render because of it.
        fetchTokenMetadata(address, evmChain, useAppStore.getState().addressChains),
      ]);
      // The row refresh is also the on-demand peak backfill. `fetchMcNow` above
      // asks DexScreener straight from the browser, so that observation never
      // reaches the peak store; this asks the backend to re-observe and fold
      // the result in, which re-derives every caller who called this token.
      // Not awaited — a slow provider must not hold the spinner.
      void refreshTokenPeak(address, { evmChain });
      if (meta) applyMetadataToStore(address, meta);
      if (mc) {
        setLiveMc((prev) => ({
          ...prev,
          [address.toLowerCase()]: { ...mc, at: Date.now() },
        }));
      }
    } finally {
      setRefreshingRow(null);
    }
  }, [setLiveMc]);

  const refreshLiveMc = async () => {
    const top = rows.slice(0, 40);
    const results = await Promise.all(
      top.map(async (r) => [r.address.toLowerCase(), await fetchMcNow(r.address)] as const),
    );
    setLiveMc((prev) => {
      const next = { ...prev };
      for (const [key, result] of results) {
        if (result) next[key] = { ...result, at: Date.now() };
      }
      return next;
    });
  };

  const refreshTokenNames = async () => {
    const top = rows.slice(0, 40);
    const results = await Promise.all(
      top.map(async (r) => [r.address, await fetchTokenMetadata(r.address, r.evmChain, useAppStore.getState().addressChains)] as const),
    );
    for (const [address, meta] of results) {
      if (meta) applyMetadataToStore(address, meta);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshLiveMc(), refreshTokenNames()]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (rows.length === 0) return;
    refreshLiveMc();
    const id = setInterval(() => {
      refreshLiveMc();
      setAgoTick((t) => t + 1);
    }, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, windowFilter]);

  return { refreshing, refreshingRow, agoTick, refreshOne, refreshAll };
}
