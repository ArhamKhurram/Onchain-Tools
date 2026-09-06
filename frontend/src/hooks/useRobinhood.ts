// Reads for the robinhoodtrenches source (Robinhood Chain, 4663 — no Solana or
// BSC). Everything goes through OCT's backend rather than the browser: one
// server-side cache, no CORS surface, and one place where the untrusted payload
// is narrowed.
//
// The live tape itself is NOT fetched here — it arrives on the existing
// WebSocket (`robinhood_fill`) into the store's robinhood slice, and is seeded
// once from REST by loadRobinhoodTape. These hooks cover the demand-driven
// panels only.

import { useCallback, useEffect, useState } from 'react';
import { getAccessToken } from '../lib/supabase';
import type { RobinhoodRadarResponse, RobinhoodRadarRow, RobinhoodStatusResponse } from '../types/robinhood';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

async function robinhoodFetch(path: string): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${API_BASE}${path}`, { headers });
}

/** Indexer health plus OCT's own poller state. Refreshes on a slow interval. */
export function useRobinhoodStatus(intervalMs = 60_000) {
  const [status, setStatus] = useState<RobinhoodStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await robinhoodFetch('/robinhood/status');
      // The status route answers 200 even when upstream is down (available:false),
      // so a non-ok here means OCT itself, not the third party.
      setStatus(res.ok ? ((await res.json()) as RobinhoodStatusResponse) : null);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (intervalMs <= 0) return;
    const id = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(id);
  }, [refresh, intervalMs]);

  return { status, loading, refresh };
}

/**
 * Fresh Robinhood Chain tokens ranked by unique tracked buyers — this source's
 * own signal, surfaced under its own name. Deliberately not merged into OCT's
 * convergence detector.
 */
export function useRobinhoodRadar(enabled: boolean) {
  const [rows, setRows] = useState<RobinhoodRadarRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const res = await robinhoodFetch('/robinhood/radar?limit=50');
      const body = (await res.json().catch(() => ({}))) as Partial<RobinhoodRadarResponse>;
      if (!res.ok || body.available === false) {
        setRows([]);
        setError(body.error ?? 'robinhoodtrenches is unreachable right now.');
        return;
      }
      setRows(Array.isArray(body.rows) ? body.rows : []);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : 'Failed to load radar.');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rows, loading, error, refresh };
}
