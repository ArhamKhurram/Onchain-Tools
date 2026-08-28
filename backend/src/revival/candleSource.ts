/**
 * Which candle source serves which chain — and the fallback that keeps a bad answer out.
 *
 * GeckoTerminal's keyless tier sustains ~6-8 requests/minute across ALL watched chains combined
 * (measured, see `candles.ts`). That single number caps the revival subsystem: a ~60-token
 * universe and a ~25-minute sweep, shared three ways. Pinax is paid, indexes Solana and BNB, and
 * serves the same shapes — so routing those two to Pinax leaves the entire GeckoTerminal budget
 * for Robinhood Chain, which Pinax does not index at all.
 *
 * Routing is deliberately conservative in both directions:
 *
 *  * Pinax is used only where it is configured AND its per-pool USD calibration succeeded. A pool
 *    whose scale factor is not a clean power of ten is refused by `pinaxCandles`, and this module
 *    then falls through to GeckoTerminal rather than trusting a guess.
 *  * With no `PINAX_API_KEY` the whole thing degrades to today's behaviour — every chain on
 *    GeckoTerminal — instead of failing. That is the shipped configuration until the key is set
 *    in the deploy environment, so it has to be the safe path, not an error path.
 *
 * `OCT_REVIVAL_PINAX_NETWORKS` (with the usual `TRENCHCORD_` fallback) overrides the routing,
 * e.g. `OCT_REVIVAL_PINAX_NETWORKS=` (empty) forces everything back onto GeckoTerminal without a
 * deploy. Unknown ids are ignored with a warning rather than throwing.
 */

import type { RevivalNetwork } from '@oct/shared';
import { isRevivalNetwork } from '@oct/shared';

import { fetchRevivalCandles, type RevivalCandleSet } from './candles.js';
import { fetchPinaxOhlc, pinaxSupports, resolvePinaxPool } from './pinaxCandles.js';

/** Minute candles for ATR/RVOL; hour candles for the 72h dormancy lookback. */
const MINUTE_LIMIT = 1000;
const HOUR_LIMIT = 100;

const DEFAULT_PINAX_NETWORKS: readonly RevivalNetwork[] = ['solana', 'bsc'];

export type CandleSourceId = 'pinax' | 'geckoterminal';

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

/** Pure parser for the env override — exported for tests. */
export function parsePinaxNetworks(raw: string | undefined | null): RevivalNetwork[] {
  if (raw == null) return [...DEFAULT_PINAX_NETWORKS];
  if (raw.trim() === '') return [];
  const out: RevivalNetwork[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim().toLowerCase();
    if (id === '') continue;
    if (!isRevivalNetwork(id)) {
      console.warn(`[CandleSource] ignoring unsupported network id in OCT_REVIVAL_PINAX_NETWORKS: ${id}`);
      continue;
    }
    if (!pinaxSupports(id)) {
      console.warn(`[CandleSource] Pinax does not index ${id}; it stays on GeckoTerminal.`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function resolvePinaxNetworks(): RevivalNetwork[] {
  return parsePinaxNetworks(envFlag('REVIVAL_PINAX_NETWORKS'));
}

/** Which source WOULD serve this chain, before any per-pool calibration is attempted. */
export function plannedSourceFor(network: RevivalNetwork): CandleSourceId {
  if (!process.env.PINAX_API_KEY?.trim()) return 'geckoterminal';
  return resolvePinaxNetworks().includes(network) ? 'pinax' : 'geckoterminal';
}

export interface SourcedCandleSet extends RevivalCandleSet {
  /** Which source actually answered — Pinax can decline a pool and hand back to GeckoTerminal. */
  source: CandleSourceId;
}

/**
 * Everything the detector needs for one token on one chain, from whichever source can serve it.
 *
 * Null only when NO source could answer. A Pinax miss is never terminal: it falls through to
 * GeckoTerminal, because the alternative — reporting "no data" for a token Pinax merely declined
 * to calibrate — would silently shrink the universe.
 */
export async function fetchCandlesForToken(
  network: RevivalNetwork,
  address: string,
): Promise<SourcedCandleSet | null> {
  if (plannedSourceFor(network) === 'pinax') {
    const pool = await resolvePinaxPool(network, address);
    if (pool) {
      const minute = await fetchPinaxOhlc(network, pool.poolAddress, '1m', MINUTE_LIMIT, pool.scale);
      if (minute.length > 0) {
        const hour = await fetchPinaxOhlc(network, pool.poolAddress, '1h', HOUR_LIMIT, pool.scale);
        return { pool, minute, hour, source: 'pinax' };
      }
    }
  }
  const gt = await fetchRevivalCandles(network, address);
  return gt ? { ...gt, source: 'geckoterminal' } : null;
}
