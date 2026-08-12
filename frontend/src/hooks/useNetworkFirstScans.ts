import { useEffect, useRef, useState } from 'react';
import { isHostedMode, getAccessToken } from '../lib/supabase';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const DEBOUNCE_MS = 500;
const BATCH_CAP = 100;

export interface NetworkFirstScan {
  firstSeenAt: string;
  fdvAtFirst: number | null;
}

/**
 * Anonymous OCT network pool: when did the network first see each address?
 * Hosted mode only (the pool lives in Supabase); in local mode this hook is
 * inert and returns an empty map. Lookups are batched into one debounced POST
 * per address-set change, and answered addresses are cached for the component's
 * lifetime — pool rows are effectively immutable, so there is nothing to poll.
 */
export function useNetworkFirstScans(addresses: string[]): Record<string, NetworkFirstScan> {
  const [scans, setScans] = useState<Record<string, NetworkFirstScan>>({});
  // Every address we've already asked about (hit or miss) — misses are cached
  // too so an address the pool doesn't know isn't re-asked on every render.
  const askedRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable key so the effect only re-runs when the address SET changes, not on
  // every new array identity from the caller's useMemo.
  const addressKey = addresses.join('\n');

  useEffect(() => {
    if (!isHostedMode) return;
    const pending = addresses.filter((a) => a && !askedRef.current.has(a)).slice(0, BATCH_CAP);
    if (pending.length === 0) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    let cancelled = false;
    timerRef.current = setTimeout(async () => {
      for (const a of pending) askedRef.current.add(a);
      try {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        const token = await getAccessToken();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const res = await fetch(`${API_BASE}/network-scans/lookup`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({ addresses: pending }),
        });
        if (!res.ok) {
          // Let a transient failure be retried on the next address-set change.
          for (const a of pending) askedRef.current.delete(a);
          return;
        }
        const data = await res.json() as { scans?: Record<string, NetworkFirstScan> };
        if (cancelled || !data.scans || Object.keys(data.scans).length === 0) return;
        setScans((prev) => ({ ...prev, ...data.scans }));
      } catch {
        for (const a of pending) askedRef.current.delete(a);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressKey]);

  return scans;
}
