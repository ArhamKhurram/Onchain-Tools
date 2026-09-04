// The Radar's network edge: DexScreener for a live market cap straight from
// the browser, and the backend token-snapshot endpoint for symbol/name.
// Moved out of RadarTable.tsx verbatim — nothing here touches React, and
// keeping it separate makes the table file about *composition* only.
import { useAppStore } from '../../stores/appStore';
import { isHostedMode, getAccessToken } from '../../lib/supabase';
import { formatCompact } from './radarRows';
import type { ContractEntry } from '../../types';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (isHostedMode) {
    const token = await getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers, credentials: 'include' });
}

export interface TokenMetadataResult {
  symbol?: string;
  name?: string;
  pair?: string;
  evmChain?: string;
  source?: ContractEntry['enrichmentSource'];
}

function resolveSnapshotChain(address: string, evmChain?: string, addressChains?: Record<string, string>): string {
  if (evmChain) return evmChain;
  const fromStore = addressChains?.[address.toLowerCase()];
  if (fromStore) return fromStore;
  return address.startsWith('0x') ? 'robinhood' : 'sol';
}

export async function fetchMcNow(address: string): Promise<{ mc: number; display: string } | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const data = await res.json() as {
      pairs?: { baseToken?: { address?: string }; fdv?: number; marketCap?: number; liquidity?: { usd?: number } }[];
    };
    const lower = address.toLowerCase();
    const pairs = (data.pairs ?? []).filter((p) =>
      p.baseToken?.address?.toLowerCase() === lower || p.baseToken?.address === address,
    );
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const mc = pairs[0].fdv ?? pairs[0].marketCap;
    if (mc == null) return null;
    return { mc, display: formatCompact(mc) };
  } catch {
    return null;
  }
}

export async function fetchTokenMetadata(
  address: string,
  evmChain?: string,
  addressChains?: Record<string, string>,
): Promise<TokenMetadataResult | null> {
  try {
    const chain = resolveSnapshotChain(address, evmChain, addressChains);
    const res = await apiFetch(
      `${API_BASE}/tokens/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/snapshot`,
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      found?: boolean;
      symbol?: string;
      name?: string;
      pair?: string;
      evmChain?: string;
      source?: ContractEntry['enrichmentSource'];
    };
    if (!data.found || (!data.symbol && !data.name)) return null;
    return {
      symbol: data.symbol,
      name: data.name,
      pair: data.pair,
      evmChain: data.evmChain,
      source: data.source,
    };
  } catch {
    return null;
  }
}

export function applyMetadataToStore(address: string, meta: TokenMetadataResult): void {
  if (!meta.symbol && !meta.name) return;
  useAppStore.getState().enrichContract({
    address,
    tokenSymbol: meta.symbol,
    tokenName: meta.name,
    tokenPair: meta.pair,
    enrichmentSource: meta.source,
    enrichedAt: new Date().toISOString(),
    evmChain: meta.evmChain,
  } as ContractEntry);
}
