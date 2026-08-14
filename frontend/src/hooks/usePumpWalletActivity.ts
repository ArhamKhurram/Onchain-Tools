import { useCallback, useEffect, useState } from 'react';
import { pumpGet, pumpPost, type PumpResult } from '../lib/pumpfunApi';
import {
  walletMintsFromTransactions,
  type PumpCallout,
  type PumpTokenPnl,
  type PumpTransaction,
  type PumpTransactionsPage,
  type PumpUser,
} from '../types/pumpfun';

// One hook for everything a single tracked wallet shows: profile + callouts (both
// KEYED — 503 when PUMPFUN_API_KEY is unset) and transactions + PnL (both
// KEYLESS). The slices carry SEPARATE error state on purpose: the whole point of
// the two-host split is that a missing key blanks the callouts panel while trades
// keep flowing, so callouts failing must never touch `transactions`, and vice
// versa. Nothing here is fused into one loading flag.

interface Slice<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** 503 from the KEYED host — render "not configured", not an error. */
  disabled: boolean;
  retryable: boolean;
}

function idleSlice<T>(initial: T): Slice<T> {
  return { data: initial, loading: false, error: null, disabled: false, retryable: false };
}

/** Fold a PumpResult into the loading/error/disabled shape a slice renders. */
function settle<T>(res: PumpResult<T>, fallback: T): Slice<T> {
  if (res.ok) return { data: res.data, loading: false, error: null, disabled: false, retryable: false };
  return {
    data: fallback,
    loading: false,
    error: res.disabled ? null : res.error,
    disabled: res.disabled,
    retryable: res.retryable,
  };
}

export function usePumpWalletActivity(address: string | null) {
  const [profile, setProfile] = useState<Slice<PumpUser | null>>(() => idleSlice<PumpUser | null>(null));
  const [callouts, setCallouts] = useState<Slice<PumpCallout[]>>(() => idleSlice<PumpCallout[]>([]));
  const [transactions, setTransactions] = useState<Slice<PumpTransaction[]>>(() => idleSlice<PumpTransaction[]>([]));

  // The transactions cursor lives outside the slice: appending a page must not
  // reset the rows already shown, so "load more" is a distinct action from the
  // slice's own refresh.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // PnL is deliberate, never auto-fired: it stays null until the user presses the
  // button (types/pumpfun.ts collects the mints, this POSTs them).
  const [pnl, setPnl] = useState<PumpTokenPnl[] | null>(null);
  const [pnlLoading, setPnlLoading] = useState(false);
  const [pnlError, setPnlError] = useState<string | null>(null);

  const loadProfile = useCallback(async (addr: string) => {
    setProfile((s) => ({ ...s, loading: true }));
    const res = await pumpGet<PumpUser>(`/wallet/${addr}`);
    setProfile(settle<PumpUser | null>(res, null));
  }, []);

  const loadCallouts = useCallback(async (addr: string) => {
    setCallouts((s) => ({ ...s, loading: true }));
    const res = await pumpGet<PumpCallout[]>(`/wallet/${addr}/callouts`);
    setCallouts(settle<PumpCallout[]>(res, []));
  }, []);

  const loadTransactions = useCallback(async (addr: string) => {
    setTransactions((s) => ({ ...s, loading: true }));
    const res = await pumpGet<PumpTransactionsPage>(`/wallet/${addr}/transactions`);
    if (res.ok) {
      setTransactions({ data: res.data.items, loading: false, error: null, disabled: false, retryable: false });
      setNextCursor(res.data.pagination.nextCursor);
      setHasMore(res.data.pagination.hasMore);
    } else {
      setTransactions(settle<PumpTransaction[]>(res, []));
      setNextCursor(null);
      setHasMore(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!address || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    const res = await pumpGet<PumpTransactionsPage>(
      `/wallet/${address}/transactions?cursor=${encodeURIComponent(nextCursor)}`,
    );
    if (res.ok) {
      // Dedup by txHash across pages — the cursor can re-emit a boundary row.
      setTransactions((s) => {
        const seen = new Set(s.data.map((t) => t.txHash));
        const merged = [...s.data, ...res.data.items.filter((t) => !seen.has(t.txHash))];
        return { ...s, data: merged };
      });
      setNextCursor(res.data.pagination.nextCursor);
      setHasMore(res.data.pagination.hasMore);
    }
    setLoadingMore(false);
  }, [address, nextCursor, loadingMore]);

  const runPnl = useCallback(async () => {
    if (!address) return;
    const mints = walletMintsFromTransactions(transactions.data);
    if (mints.length === 0) {
      setPnl([]);
      setPnlError(null);
      return;
    }
    setPnlLoading(true);
    setPnlError(null);
    const res = await pumpPost<PumpTokenPnl[]>(`/wallet/${address}/pnl`, { mints });
    if (res.ok) setPnl(res.data);
    else setPnlError(res.error);
    setPnlLoading(false);
  }, [address, transactions.data]);

  // Reset and reload whenever the selected wallet changes. Clearing PnL on switch
  // is essential: a stale PnL table under a different wallet's header would
  // misattribute one trader's realized gains to another.
  useEffect(() => {
    setPnl(null);
    setPnlError(null);
    setNextCursor(null);
    setHasMore(false);
    if (!address) {
      setProfile(idleSlice<PumpUser | null>(null));
      setCallouts(idleSlice<PumpCallout[]>([]));
      setTransactions(idleSlice<PumpTransaction[]>([]));
      return;
    }
    void loadProfile(address);
    void loadCallouts(address);
    void loadTransactions(address);
  }, [address, loadProfile, loadCallouts, loadTransactions]);

  const refresh = useCallback(() => {
    if (!address) return;
    void loadProfile(address);
    void loadCallouts(address);
    void loadTransactions(address);
  }, [address, loadProfile, loadCallouts, loadTransactions]);

  return {
    profile,
    callouts,
    transactions,
    hasMore,
    loadingMore,
    loadMore,
    refresh,
    pnl,
    pnlLoading,
    pnlError,
    runPnl,
  };
}
