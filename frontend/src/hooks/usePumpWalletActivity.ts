import { useCallback, useEffect, useRef, useState } from 'react';
import { pumpGet, pumpPost, type PumpResult } from '../lib/pumpfunApi';
import { PUMP_RETRY_MAX_ATTEMPTS, pumpBackoffMs } from '../lib/pumpBackoff';
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
//
// TWO resilience behaviours layer on top of that split:
//   1. A per-session client cache (module-level, keyed by address) so flipping
//      back to an already-viewed trader is instant and re-fires nothing.
//   2. Self-healing auto-retry on a 429 rate-limit (the shared KEYED key being
//      paced): instead of a raw error, the slice shows a calm "retrying" state and
//      backs off exponentially, up to PUMP_RETRY_MAX_ATTEMPTS, then leaves a
//      manual retry. The raw endpoint/status string is never surfaced.

interface Slice<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** 503 from the KEYED host — render "not configured", not an error. */
  disabled: boolean;
  retryable: boolean;
  /** 429 — the shared key is rate-limited. Render the calm state, not the error. */
  rateLimited: boolean;
  /** An automatic backoff retry is pending for this slice. */
  retrying: boolean;
}

function idleSlice<T>(initial: T): Slice<T> {
  return { data: initial, loading: false, error: null, disabled: false, retryable: false, rateLimited: false, retrying: false };
}

/** Fold a PumpResult into the loading/error/disabled shape a slice renders. */
function settle<T>(res: PumpResult<T>, fallback: T): Slice<T> {
  if (res.ok) {
    return { data: res.data, loading: false, error: null, disabled: false, retryable: false, rateLimited: false, retrying: false };
  }
  return {
    data: fallback,
    loading: false,
    // Suppress the raw message for both the "not configured" (disabled) and the
    // rate-limited states — those render their own calm copy. Every other failure
    // keeps the server's message.
    error: res.disabled || res.rateLimited ? null : res.error,
    disabled: res.disabled,
    retryable: res.retryable,
    rateLimited: res.rateLimited,
    retrying: false,
  };
}

// -------------------------------------------------------------------------
// Per-session client cache. Module-level so it survives panel unmount/remount
// (switching the selected wallet remounts PumpWalletPanel via its `key`), giving
// an already-viewed trader an instant, refetch-free reopen. Only SUCCESSFUL reads
// are stored — a failed/rate-limited first visit leaves no entry, so a revisit
// still fetches. Presence is checked by key (`'profile' in entry`) because a
// profile can legitimately be cached as null (a wallet with no pump identity).
// -------------------------------------------------------------------------
interface CachedWallet {
  profile?: PumpUser | null;
  callouts?: PumpCallout[];
  transactions?: { items: PumpTransaction[]; nextCursor: string | null; hasMore: boolean };
}
const sessionCache = new Map<string, CachedWallet>();

function patchCache(addr: string, patch: CachedWallet): void {
  sessionCache.set(addr, { ...(sessionCache.get(addr) ?? {}), ...patch });
}

type SliceName = 'profile' | 'callouts' | 'transactions';

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

  // Auto-retry bookkeeping. Refs (not state) so a pending timer and its attempt
  // count survive re-renders and can be cancelled synchronously when the wallet
  // changes — a stale timer from wallet A must never apply a result to wallet B.
  const activeAddress = useRef<string | null>(null);
  const timers = useRef<Record<SliceName, ReturnType<typeof setTimeout> | undefined>>({
    profile: undefined,
    callouts: undefined,
    transactions: undefined,
  });
  const attempts = useRef<Record<SliceName, number>>({ profile: 0, callouts: 0, transactions: 0 });

  const clearTimer = useCallback((name: SliceName) => {
    const t = timers.current[name];
    if (t !== undefined) {
      clearTimeout(t);
      timers.current[name] = undefined;
    }
  }, []);

  const resetRetries = useCallback(() => {
    clearTimer('profile');
    clearTimer('callouts');
    clearTimer('transactions');
    attempts.current = { profile: 0, callouts: 0, transactions: 0 };
  }, [clearTimer]);

  // Schedule the next backoff retry for a slice, bounded by PUMP_RETRY_MAX_ATTEMPTS.
  // Returns whether a retry was actually scheduled (false once the budget is spent).
  const scheduleRetry = useCallback(
    (name: SliceName, addr: string, retryAfter: number | null, run: () => void): boolean => {
      const attempt = attempts.current[name];
      if (attempt >= PUMP_RETRY_MAX_ATTEMPTS) return false;
      attempts.current[name] = attempt + 1;
      clearTimer(name);
      timers.current[name] = setTimeout(() => {
        timers.current[name] = undefined;
        if (activeAddress.current === addr) run();
      }, pumpBackoffMs(attempt, retryAfter));
      return true;
    },
    [clearTimer],
  );

  const loadProfile = useCallback(
    (addr: string, force = false) => {
      if (!force && attempts.current.profile === 0) {
        const cached = sessionCache.get(addr);
        if (cached && 'profile' in cached) {
          setProfile({ ...idleSlice<PumpUser | null>(cached.profile ?? null) });
          return;
        }
      }
      setProfile((s) => ({ ...s, loading: true }));
      void pumpGet<PumpUser>(`/wallet/${addr}`).then((res) => {
        if (activeAddress.current !== addr) return;
        if (res.ok) {
          patchCache(addr, { profile: res.data });
          attempts.current.profile = 0;
          setProfile(settle<PumpUser | null>(res, null));
          return;
        }
        if (res.rateLimited && scheduleRetry('profile', addr, res.retryAfter, () => loadProfile(addr, true))) {
          setProfile({ ...settle<PumpUser | null>(res, null), retrying: true });
          return;
        }
        setProfile(settle<PumpUser | null>(res, null));
      });
    },
    [scheduleRetry],
  );

  const loadCallouts = useCallback(
    (addr: string, force = false) => {
      if (!force && attempts.current.callouts === 0) {
        const cached = sessionCache.get(addr);
        if (cached?.callouts) {
          setCallouts({ ...idleSlice<PumpCallout[]>(cached.callouts) });
          return;
        }
      }
      setCallouts((s) => ({ ...s, loading: true }));
      void pumpGet<PumpCallout[]>(`/wallet/${addr}/callouts`).then((res) => {
        if (activeAddress.current !== addr) return;
        if (res.ok) {
          patchCache(addr, { callouts: res.data });
          attempts.current.callouts = 0;
          setCallouts(settle<PumpCallout[]>(res, []));
          return;
        }
        if (res.rateLimited && scheduleRetry('callouts', addr, res.retryAfter, () => loadCallouts(addr, true))) {
          setCallouts({ ...settle<PumpCallout[]>(res, []), retrying: true });
          return;
        }
        setCallouts(settle<PumpCallout[]>(res, []));
      });
    },
    [scheduleRetry],
  );

  const loadTransactions = useCallback(
    (addr: string, force = false) => {
      if (!force && attempts.current.transactions === 0) {
        const cached = sessionCache.get(addr);
        if (cached?.transactions) {
          setTransactions({ ...idleSlice<PumpTransaction[]>(cached.transactions.items) });
          setNextCursor(cached.transactions.nextCursor);
          setHasMore(cached.transactions.hasMore);
          return;
        }
      }
      setTransactions((s) => ({ ...s, loading: true }));
      void pumpGet<PumpTransactionsPage>(`/wallet/${addr}/transactions`).then((res) => {
        if (activeAddress.current !== addr) return;
        if (res.ok) {
          patchCache(addr, {
            transactions: { items: res.data.items, nextCursor: res.data.pagination.nextCursor, hasMore: res.data.pagination.hasMore },
          });
          attempts.current.transactions = 0;
          setTransactions({ ...idleSlice<PumpTransaction[]>(res.data.items) });
          setNextCursor(res.data.pagination.nextCursor);
          setHasMore(res.data.pagination.hasMore);
          return;
        }
        if (res.rateLimited && scheduleRetry('transactions', addr, res.retryAfter, () => loadTransactions(addr, true))) {
          setTransactions({ ...settle<PumpTransaction[]>(res, []), retrying: true });
          setNextCursor(null);
          setHasMore(false);
          return;
        }
        setTransactions(settle<PumpTransaction[]>(res, []));
        setNextCursor(null);
        setHasMore(false);
      });
    },
    [scheduleRetry],
  );

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
        // Keep the session cache in step so a reopen shows the fuller, paged list.
        patchCache(address, { transactions: { items: merged, nextCursor: res.data.pagination.nextCursor, hasMore: res.data.pagination.hasMore } });
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
  // misattribute one trader's realized gains to another. Pending retries from the
  // previous wallet are cancelled first so none applies after the switch.
  useEffect(() => {
    activeAddress.current = address;
    resetRetries();
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
    loadProfile(address);
    loadCallouts(address);
    loadTransactions(address);
    return () => {
      resetRetries();
    };
  }, [address, resetRetries, loadProfile, loadCallouts, loadTransactions]);

  // A manual refresh forces past both the session cache and any spent retry
  // budget — the user is explicitly asking for fresh data.
  const refresh = useCallback(() => {
    if (!address) return;
    resetRetries();
    loadProfile(address, true);
    loadCallouts(address, true);
    loadTransactions(address, true);
  }, [address, resetRetries, loadProfile, loadCallouts, loadTransactions]);

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
