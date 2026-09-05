// Bounded token-peak refresh.
//
// Caller stats accumulate forever; token peaks deliberately do NOT get tracked
// forever. The 3-minute sampler already walks tokens called in the last 72
// hours, and that is the right cost ceiling — a persistent board must not turn
// into a permanently growing polling set. So a token's peak moves on exactly
// two occasions beyond that window:
//
//   1. ON RE-SCAN — the token crossed the feed again, so somebody cares right
//      now. Debounced per address so a spam repost is one fetch, not fifty.
//   2. ON DEMAND — the operator asks for one specific token.
//
// Because caller multiples are computed by JOINing token_peaks at read time
// (see the migration), a refreshed peak re-derives every affected caller's
// stats implicitly. There is no fan-out write and nothing to keep in sync.
//
// Provider split is respected: this reuses `fetchLiveMarketCap`, which is GMGN
// first (when GMGN_API_KEY is set) and DexScreener as fallback. Birdeye is
// portfolio-only and is not wired in here.

import { getPeaks, recordPeak } from '../alerts/tokenPeakStore.js';
import { fetchLiveMarketCap } from '../utils/tokenEnrichment.js';

export interface PeakRefreshTarget {
  address: string;
  chain?: 'evm' | 'sol';
  evmChain?: string;
}

export interface PeakRefreshResult {
  address: string;
  /** Live market cap observed just now, if the providers had one. */
  mcNow?: number;
  /** The peak after folding that observation in — a max-upsert, never lowered. */
  peakMc?: number;
  /** True when this observation set a new high-water mark. */
  raised: boolean;
}

/** Per-address cooldown, so a token reposted twenty times is refreshed once. */
const DEFAULT_RESCAN_COOLDOWN_MS = 300_000; // 5 min
/**
 * Cap on the debounce map. Addresses fall out oldest-first; the only cost of an
 * eviction is one extra fetch, so a hard bound beats unbounded memory.
 */
const MAX_TRACKED_ADDRESSES = 5_000;

const lastRefreshAt = new Map<string, number>();

function cooldownMs(): number {
  return (
    Number.parseInt(process.env.CALLER_PEAK_RESCAN_COOLDOWN_MS ?? '', 10) ||
    DEFAULT_RESCAN_COOLDOWN_MS
  );
}

/**
 * Has this address cooled down enough to refresh again? Marks it as refreshed
 * when the answer is yes, so two concurrent scans of the same token don't both
 * pass the gate.
 */
export function claimRescanRefresh(address: string, now = Date.now()): boolean {
  const key = address.toLowerCase();
  const prev = lastRefreshAt.get(key);
  if (prev != null && now - prev < cooldownMs()) return false;

  // Map iteration order is insertion order, so the first key is the oldest
  // claim — re-set on claim below keeps that true.
  if (!lastRefreshAt.has(key) && lastRefreshAt.size >= MAX_TRACKED_ADDRESSES) {
    const oldest = lastRefreshAt.keys().next();
    if (!oldest.done) lastRefreshAt.delete(oldest.value);
  }
  lastRefreshAt.delete(key);
  lastRefreshAt.set(key, now);
  return true;
}

function inferChain(target: PeakRefreshTarget): 'evm' | 'sol' {
  return target.chain ?? (target.address.startsWith('0x') ? 'evm' : 'sol');
}

/**
 * Fetch one token's live market cap and fold it into the peak store.
 *
 * Honesty note, inherited from `tokenPeakBackfill`: the value folded in is
 * *today's* MC, not the token's true ATH since the call. GMGN and DexScreener
 * as wired here both serve current state, not history, so a peak stays what it
 * has always been — a high-water mark of observations, an honest floor that
 * more observations only ever raise. The console already words multiples as
 * floors rather than exact ATHs.
 */
export async function refreshTokenPeak(target: PeakRefreshTarget): Promise<PeakRefreshResult> {
  const address = target.address;
  const key = address.toLowerCase();
  const before = (await getPeaks([address])).get(key);

  const live = await fetchLiveMarketCap(address, target.evmChain ?? undefined);
  const mcNow = live?.mcNow;
  if (mcNow == null || !(mcNow > 0)) {
    return { address, peakMc: before, raised: false };
  }

  await recordPeak({
    address,
    chain: inferChain(target),
    evmChain: target.evmChain,
    mcNow,
  });

  const peakMc = Math.max(before ?? 0, mcNow);
  return { address, mcNow, peakMc, raised: peakMc > (before ?? 0) };
}

/**
 * Fire-and-forget refresh for a token that just crossed the feed again.
 *
 * Never awaited by the ingest path and never throws into it: a peak refresh is
 * an improvement to a score, not a step in delivering a message.
 */
export function refreshTokenPeakOnRescan(target: PeakRefreshTarget): void {
  if (!target.address) return;
  if (!claimRescanRefresh(target.address)) return;
  void refreshTokenPeak(target).catch((err) =>
    console.error('[CallerStats] peak re-scan refresh failed:', (err as Error)?.message),
  );
}
