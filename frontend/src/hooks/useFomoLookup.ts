// On-demand FOMO lookups: the top-holders board for a token, and a trader's
// public profile. Both read the shared FOMO service account through the
// backend, so they need an authenticated session but no per-user state.
//
// Every call here lands on the single-tab Chromium worker (see fomo-worker),
// so both hooks are demand-driven only — no polling, no refetch on focus. The
// backend's TTL cache (hodlers 15 min) absorbs repeat lookups of the same token.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BotHoldersResponse,
  BotThesesResponse,
  BotTraderActivityResponse,
  BotWalletProfile,
} from '@oct/shared';
import { getAccessToken } from '../lib/supabase';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

async function fomoFetch(input: string): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { headers });
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? fallback;
}

/**
 * Top FOMO holders for a token. Pass `network` to pin the chain; omit it and
 * the backend infers it from the address shape.
 *
 * `address` of null idles the hook — that is how the drawer avoids fetching
 * while closed.
 */
export function useFomoHolders(address: string | null, network?: string | null) {
  const [data, setData] = useState<BotHoldersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow first request overwriting a newer token's result.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!address) {
      setData(null);
      setError(null);
      return;
    }

    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ address });
      if (network) params.set('network', network);
      const res = await fomoFetch(`${API_BASE}/fomo/hodlers/top?${params}`);
      if (seq !== requestSeq.current) return;

      if (!res.ok) {
        setData(null);
        setError(await readError(res, `Failed to load holders (${res.status}).`));
        return;
      }
      setData((await res.json()) as BotHoldersResponse);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setData(null);
      setError((err as Error)?.message ?? 'Failed to load holders.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [address, network]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: load };
}

/**
 * Written FOMO theses for a token: per-trader position, PnL and thesis text.
 * Same demand-driven contract as useFomoHolders — `address` of null idles the
 * hook, `network` pins the chain (omit to infer from the address shape), and the
 * backend's TTL cache (theses 3 min) absorbs repeat views of the same token.
 */
export function useFomoTheses(address: string | null, network?: string | null) {
  const [data, setData] = useState<BotThesesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow first request overwriting a newer token's result.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!address) {
      setData(null);
      setError(null);
      return;
    }

    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (network) params.set('network', network);
      const qs = params.toString();
      const res = await fomoFetch(
        `${API_BASE}/fomo/token/${encodeURIComponent(address)}/theses${qs ? `?${qs}` : ''}`,
      );
      if (seq !== requestSeq.current) return;

      if (!res.ok) {
        setData(null);
        setError(await readError(res, `Failed to load theses (${res.status}).`));
        return;
      }
      setData((await res.json()) as BotThesesResponse);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setData(null);
      setError((err as Error)?.message ?? 'Failed to load theses.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [address, network]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: load };
}

/**
 * A FOMO trader's profile, holdings and PnL. Manual-submit rather than
 * search-as-you-type: each lookup is a fuzzy search plus a balances call on the
 * worker, which is too expensive to fire per keystroke.
 */
export function useFomoTraderLookup() {
  const [data, setData] = useState<BotWalletProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const lookup = useCallback(async (query: string) => {
    const term = query.trim();
    if (!term) return;

    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fomoFetch(`${API_BASE}/fomo/wallet?q=${encodeURIComponent(term)}`);
      if (seq !== requestSeq.current) return;

      if (!res.ok) {
        setData(null);
        setError(await readError(res, `Lookup failed (${res.status}).`));
        return;
      }
      setData((await res.json()) as BotWalletProfile);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setData(null);
      setError((err as Error)?.message ?? 'Lookup failed.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    requestSeq.current += 1;
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return { data, loading, error, lookup, reset };
}

/**
 * A FOMO trader's recent swaps and transfers, keyed by the internal
 * `fomoUserId` the profile lookup returns.
 *
 * Same demand-driven contract as useFomoHolders — a null id idles the hook, so
 * the Traders tab fetches nothing until a lookup has resolved a trader. Fires
 * separately from the profile call rather than being folded into it: the card
 * should paint as soon as the profile lands instead of waiting on a second
 * round-trip to the Chromium worker.
 */
export function useFomoTraderActivity(fomoUserId: string | null) {
  const [data, setData] = useState<BotTraderActivityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow first request overwriting a newer trader's result.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!fomoUserId) {
      setData(null);
      setError(null);
      return;
    }

    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fomoFetch(
        `${API_BASE}/fomo/activity?userId=${encodeURIComponent(fomoUserId)}`,
      );
      if (seq !== requestSeq.current) return;

      if (!res.ok) {
        setData(null);
        setError(await readError(res, `Failed to load activity (${res.status}).`));
        return;
      }
      setData((await res.json()) as BotTraderActivityResponse);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setData(null);
      setError((err as Error)?.message ?? 'Failed to load activity.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [fomoUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: load };
}
