// On-demand top-holders board for one pump.fun coin, the pump counterpart to
// useFomoHolders. Demand-driven only (no polling): the drawer passes a mint when
// open and null when closed, and the backend's TTL cache (2 min) absorbs repeats.
//
// Solana-only by nature — the board is on-chain holder data — so the caller
// should idle this hook (pass null) for non-Solana tokens rather than fetch a
// 400. The hook itself just fetches whatever mint it's handed.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PumpHoldersResponse } from '../types/pumpfun';
import { getAccessToken } from '../lib/supabase';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

async function pumpFetch(input: string): Promise<Response> {
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
 * Top pump.fun holders for a coin. `mint` of null idles the hook — that is how
 * the drawer avoids fetching while closed or for a non-Solana token.
 */
export function usePumpHolders(mint: string | null) {
  const [data, setData] = useState<PumpHoldersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow first request overwriting a newer token's result.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!mint) {
      setData(null);
      setError(null);
      return;
    }

    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await pumpFetch(`${API_BASE}/pumpfun/token/${encodeURIComponent(mint)}/holders`);
      if (seq !== requestSeq.current) return;

      if (!res.ok) {
        setData(null);
        setError(await readError(res, `Failed to load holders (${res.status}).`));
        return;
      }
      setData((await res.json()) as PumpHoldersResponse);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setData(null);
      setError((err as Error)?.message ?? 'Failed to load holders.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [mint]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: load };
}
