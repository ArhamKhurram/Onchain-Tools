/**
 * Daily SOL/USD prices for journal PnL. Two keyless sources:
 * - TODAY: DexScreener wSOL pairs (already the app's fallback price provider),
 *   cached 10 min — new trades arrive minutes old, so "current" ≈ trade-day.
 * - HISTORY (initial wallet backfill): one CoinGecko market_chart/range call
 *   fills the day map for the whole span, exactly like the audit script did.
 *
 * Best-effort by design: a missing price leaves amountUsd null (PnL stays
 * correct in SOL, the canonical unit) rather than fabricating a number.
 */

import { WSOL_MINT } from './normalize.js';

const priceByDay = new Map<string, number>();
const fetchedRanges: { fromMs: number; toMs: number }[] = [];

let currentPrice: number | null = null;
let currentPriceAt = 0;
const CURRENT_PRICE_TTL_MS = 10 * 60_000;

export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Cached lookup only — returns null when the day was never fetched. */
export function solPriceForDay(day: string): number | null {
  return priceByDay.get(day) ?? null;
}

/** Current SOL price via DexScreener (10-min cache), also stamps today. */
export async function getCurrentSolPrice(): Promise<number | null> {
  const now = Date.now();
  if (currentPrice != null && now - currentPriceAt < CURRENT_PRICE_TTL_MS) {
    return currentPrice;
  }
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WSOL_MINT}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return currentPrice;
    const body = (await res.json()) as {
      pairs?: { baseToken?: { address?: string }; liquidity?: { usd?: number }; priceUsd?: string }[];
    };
    const pairs = (body.pairs ?? [])
      .filter((p) => p.baseToken?.address === WSOL_MINT && p.priceUsd)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = pairs.length > 0 ? Number(pairs[0].priceUsd) : NaN;
    if (Number.isFinite(price) && price > 0) {
      currentPrice = price;
      currentPriceAt = now;
      priceByDay.set(dayOf(new Date(now).toISOString()), price);
    }
  } catch (err) {
    console.warn('[Journal] SOL price fetch failed:', (err as Error).message);
  }
  return currentPrice;
}

/**
 * Ensure the day map covers [fromMs, toMs] (CoinGecko daily closes). Ranges
 * already fetched are skipped; failures are logged once per call and leave
 * the affected days null.
 */
export async function ensureDailySolPrices(fromMs: number, toMs: number): Promise<void> {
  if (!(fromMs < toMs)) return;
  if (fetchedRanges.some((r) => r.fromMs <= fromMs && r.toMs >= toMs)) return;
  try {
    const from = Math.floor(fromMs / 1000) - 86_400;
    const to = Math.floor(toMs / 1000) + 86_400;
    const url =
      `https://api.coingecko.com/api/v3/coins/solana/market_chart/range` +
      `?vs_currency=usd&from=${from}&to=${to}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[Journal] CoinGecko SOL price range failed: HTTP ${res.status}`);
      return;
    }
    const body = (await res.json()) as { prices?: [number, number][] };
    for (const [ms, price] of body.prices ?? []) {
      if (Number.isFinite(price) && price > 0) {
        priceByDay.set(dayOf(new Date(ms).toISOString()), price);
      }
    }
    fetchedRanges.push({ fromMs, toMs });
  } catch (err) {
    console.warn('[Journal] CoinGecko SOL price range failed:', (err as Error).message);
  }
}
