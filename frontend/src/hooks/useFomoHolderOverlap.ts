import { useCallback, useEffect, useRef, useState } from 'react';
import { getAccessToken } from '../lib/supabase';
import type { ContractEntry } from '../types';
import type { FomoHolderOverlap } from '../types/fomo';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

function networkIdFromContract(chain: 'evm' | 'sol', evmChain?: string): number | null {
  if (chain === 'sol') return 1399811149;
  switch ((evmChain ?? '').toLowerCase()) {
    case 'eth':
    case 'ethereum':
      return 1;
    case 'bsc':
    case 'bnb':
      return 56;
    case 'base':
      return 8453;
    default:
      return null;
  }
}

export function useFomoHolderOverlap(contracts: ContractEntry[]) {
  const [overlaps, setOverlaps] = useState<Record<string, FomoHolderOverlap>>({});
  const [loading, setLoading] = useState(false);
  const lastKey = useRef('');

  const refresh = useCallback(async () => {
    const tokens = contracts
      .slice(0, 40)
      .map((c) => {
        const networkId = networkIdFromContract(c.chain, c.evmChain);
        return networkId ? { address: c.address, chain: c.chain, evmChain: c.evmChain } : null;
      })
      .filter(Boolean);

    if (tokens.length === 0) {
      setOverlaps({});
      return;
    }

    const key = tokens.map((t) => `${t!.address}:${t!.evmChain ?? t!.chain}`).join('|');
    if (key === lastKey.current) return;
    lastKey.current = key;

    setLoading(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = await getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`${API_BASE}/fomo/hodlers/overlap`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tokens }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOverlaps({});
        return;
      }
      setOverlaps(body.overlaps ?? {});
    } catch {
      setOverlaps({});
    } finally {
      setLoading(false);
    }
  }, [contracts]);

  useEffect(() => {
    const id = setTimeout(refresh, 400);
    return () => clearTimeout(id);
  }, [refresh]);

  return { overlaps, loading };
}
