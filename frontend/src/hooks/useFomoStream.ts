// Listener health for the 985monitor.xyz live stream. Goes through OCT's
// backend rather than the browser: the SSE connection is held server-side, so
// this is only the status read the panel needs to tell "off" from "down".
//
// The tape itself is NOT fetched here — it arrives on the existing WebSocket
// (`fomo_stream_trade`) into the store's fomoStream slice, and is seeded once
// from REST by loadFomoStreamTape.

import { useCallback, useEffect, useState } from 'react';
import { getAccessToken } from '../lib/supabase';
import type { FomoStreamStatusResponse } from '../types/fomoStream';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export function useFomoStreamStatus(intervalMs = 60_000) {
  const [status, setStatus] = useState<FomoStreamStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const token = await getAccessToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const res = await fetch(`${API_BASE}/fomo/stream/status`, { headers });
      // The status route answers 200 even when the source is down
      // (available:false), so a non-ok here means OCT itself, not the third party.
      setStatus(res.ok ? ((await res.json()) as FomoStreamStatusResponse) : null);
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
