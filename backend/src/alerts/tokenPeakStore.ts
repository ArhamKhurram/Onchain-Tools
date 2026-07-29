/**
 * Token peak store — the high-water market cap seen for a token since we first
 * saw it called.
 *
 * This is the input to caller scoring. Scoring against *current* MC would mark
 * down every caller whose token ran and then bled out, which is nearly all of
 * them — you'd end up measuring how long ago someone called something rather
 * than whether the call was good. The peak is the honest input.
 *
 * Peaks are a global fact about a token, not per-user, so hosted mode keys them
 * by (address, chain) with no user_id — same shape as `token_catalog`. Local
 * mode keeps a JSON file so the desktop app scores callers too; without it,
 * everything below Phase 1 would be hosted-only.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { isHostedMode } from '../storage/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const LOCAL_PATH = join(DATA_DIR, 'token-peaks.json');

export interface TokenPeak {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
  peakMc: number;
  peakAt: string;
  lastMc: number;
  updatedAt: string;
}

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// --- local JSON backing -----------------------------------------------------

let localCache: Record<string, TokenPeak> | null = null;

function loadLocal(): Record<string, TokenPeak> {
  if (localCache) return localCache;
  try {
    localCache = existsSync(LOCAL_PATH)
      ? (JSON.parse(readFileSync(LOCAL_PATH, 'utf-8')) as Record<string, TokenPeak>)
      : {};
  } catch (err) {
    console.error('[TokenPeaks] Failed to load local store:', (err as Error).message);
    localCache = {};
  }
  return localCache;
}

function saveLocal(): void {
  try {
    writeFileSync(LOCAL_PATH, JSON.stringify(localCache ?? {}, null, 2), 'utf-8');
  } catch (err) {
    console.error('[TokenPeaks] Failed to save local store:', (err as Error).message);
  }
}

// --- public API -------------------------------------------------------------

export async function recordPeak(peak: {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
  mcNow: number;
}): Promise<void> {
  if (!(peak.mcNow > 0)) return;
  const key = peak.address.toLowerCase();
  const now = new Date().toISOString();

  if (!isHostedMode()) {
    const store = loadLocal();
    const prior = store[key];
    store[key] = {
      address: peak.address,
      chain: peak.chain,
      evmChain: peak.evmChain,
      peakMc: Math.max(prior?.peakMc ?? 0, peak.mcNow),
      peakAt: !prior || peak.mcNow > prior.peakMc ? now : prior.peakAt,
      lastMc: peak.mcNow,
      updatedAt: now,
    };
    saveLocal();
    return;
  }

  const client = serviceClient();
  if (!client) return;

  const { data } = await client
    .from('token_peaks')
    .select('peak_mc, peak_at')
    .ilike('address', key)
    .eq('chain', peak.chain)
    .maybeSingle();

  const priorPeak = data?.peak_mc != null ? Number(data.peak_mc) : 0;
  const isNewPeak = peak.mcNow > priorPeak;

  const { error } = await client.from('token_peaks').upsert(
    {
      address: key,
      chain: peak.chain,
      evm_chain: peak.evmChain ?? null,
      peak_mc: Math.max(priorPeak, peak.mcNow),
      peak_at: isNewPeak ? now : (data?.peak_at ?? now),
      last_mc: peak.mcNow,
      updated_at: now,
    },
    { onConflict: 'address,chain' },
  );
  if (error) console.error('[TokenPeaks] upsert failed:', error.message);
}

/** Peaks for a set of addresses, keyed lowercase. Missing addresses are absent. */
export async function getPeaks(addresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  if (wanted.size === 0) return out;

  if (!isHostedMode()) {
    const store = loadLocal();
    for (const key of wanted) {
      const row = store[key];
      if (row?.peakMc > 0) out.set(key, row.peakMc);
    }
    return out;
  }

  const client = serviceClient();
  if (!client) return out;

  // Chunked so a long lookback can't blow past the URL length limit on `.in()`.
  const keys = [...wanted];
  const CHUNK = 200;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const { data, error } = await client
      .from('token_peaks')
      .select('address, peak_mc')
      .in('address', keys.slice(i, i + CHUNK));
    if (error) {
      console.error('[TokenPeaks] read failed:', error.message);
      continue;
    }
    for (const row of data ?? []) {
      const mc = row.peak_mc != null ? Number(row.peak_mc) : 0;
      if (mc > 0) out.set(String(row.address).toLowerCase(), mc);
    }
  }
  return out;
}

/** Test seam — drops the in-memory local cache. */
export function resetLocalPeakCache(): void {
  localCache = null;
}
