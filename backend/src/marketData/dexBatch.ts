/**
 * DexScreener batch token reads — the 30-pair cap, and the halving retry that
 * makes it survivable. Shared by every subsystem that needs "current price and
 * market cap for N mints" without inventing its own upstream client.
 *
 * WHY THIS IS ITS OWN MODULE, AND NOT A PRIVATE HELPER AGAIN. This logic was
 * written once for the price-alert poller (`priceAlerts/crossing.ts` +
 * `priceAlerts/poller.ts#readSnapshots`) around a measured, undocumented
 * failure of the upstream API. When the market-cap crossing signal needed the
 * same read, copy-pasting it would have meant two copies of a workaround for a
 * bug that is invisible unless you already know about it — and the copy that
 * drifted would fail SILENTLY, by under-reporting tokens rather than erroring.
 * So it moved here and both callers use it. `priceAlerts/crossing.ts` re-exports
 * the pure half so its existing imports and tests are untouched.
 *
 * THE 30-PAIR CAP. `/latest/dex/tokens/{a,b,c,…}` documents a 30-ADDRESS limit
 * but caps the RESPONSE at 30 PAIRS — not 30 tokens. Measured against the live
 * API on 2026-08-14: 10 liquid Solana mints went in, 30 pairs came back, and
 * they covered only 7 of the mints. The other 3 were silently absent, which is
 * indistinguishable from "this token is not listed" unless you know the cap
 * exists. A poller that reads a missing mint as "no data" abstains forever on
 * whichever tokens happen to have the most pools — i.e. exactly the liquid ones
 * worth watching.
 *
 * So the cap is treated as the real limit: batches are small (DEFAULT_BATCH_SIZE),
 * and any batch that comes back AT the cap with mints unaccounted for is
 * re-queried in halves, down to singletons. A singleton that still returns
 * nothing is genuinely unlisted, and the caller abstains on it.
 *
 * REQUEST BUDGET. DexScreener's keyless ceiling for this endpoint family is
 * ~300 req/min and it is shared by every caller in this process. Requests are
 * spaced (DEFAULT_REQUEST_SPACING_MS) and each caller passes its own label so a
 * rate-limit warning names the subsystem that earned it. The halving retry adds
 * at most ~log2(batchSize) extra requests per affected batch.
 *
 * Everything above `readDexSnapshots` is pure and unit-tested in
 * backend/test/priceAlertCrossing.test.ts and backend/test/dexBatch.test.ts.
 */

import { num } from '../utils/untrusted.js';

/** The subset of a DexScreener pair these subsystems read. */
export interface DexPair {
  baseToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  priceUsd?: string;
  /** Token-level; `fdv` is the fallback when `marketCap` is absent. */
  marketCap?: number;
  fdv?: number;
  /**
   * PER-PAIR traded USD by window. Unlike every other field on this interface
   * it is ADDITIVE across a token's pools — see `snapshotsFromPairs`.
   */
  volume?: { h24?: number };
  /**
   * PER-PAIR price change by window, in PERCENT (DexScreener's own unit, e.g.
   * -20.52 for a 20.52% drop). A property of the pool's own tape, so it is read
   * off the deepest pair like price and liquidity — never summed.
   */
  priceChange?: { h1?: number | string; h6?: number | string; h24?: number | string };
  /** Pool creation time, ms epoch. Best-effort; the basis for pool age. */
  pairCreatedAt?: number | string;
  /** DexScreener's own chain slug ("solana", "bsc", …). Best-effort. */
  chainId?: string;
}

export interface MintSnapshot {
  mint: string;
  symbol: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  /** Deepest pair's USD liquidity. Null when no pair reported one. */
  liquidityUsd: number | null;
  /**
   * Traded USD over 24h, SUMMED across every pool for this mint. Null — never
   * zero — when no pool reported a figure, because "DexScreener did not say"
   * and "nobody traded it" are different facts and only one of them is
   * evidence. See `snapshotsFromPairs`.
   */
  volume24hUsd: number | null;
  /**
   * 24h price change as a FRACTION (DexScreener's percent ÷ 100, so -0.2052 for
   * a 20.52% drop), read from the deepest pair. Null — never zero — when no
   * figure was reported, so a data gap can never read as "flat". The market-cap
   * crossing signal uses the SIGN of this to tell a first run-up from a
   * fall-back through the target (mcapCross/gates.ts).
   */
  priceChangeH24: number | null;
  /** 6h price change as a fraction, deepest pair. Carried for context; the gate uses h24. */
  priceChangeH6: number | null;
  /**
   * Pool creation time (ms epoch) of the OLDEST reporting pool — i.e. how long
   * the token has been tradeable at all. Null when no pool reported one. Used
   * as the basis for pool age, a corroborating first-run-up signal.
   */
  pairCreatedAtMs: number | null;
  /** DexScreener chain slug from the deepest pair, when it reported one. */
  chainId: string | null;
}

/** DexScreener prints price change in percent; the snapshot stores a fraction. */
function pctToFraction(value: unknown): number | null {
  const pct = num(value);
  return pct == null ? null : pct / 100;
}

/** See the module header: the RESPONSE cap, not the address cap. */
export const DEX_PAIR_CAP = 30;

/**
 * Mints per request. 10 keeps a typical memecoin watchlist (1-3 pools each)
 * comfortably under the 30-pair cap, so the retry path is the exception rather
 * than the rule.
 */
export const DEFAULT_BATCH_SIZE = 10;

/** Polite spacing between keyless DexScreener requests. */
export const DEFAULT_REQUEST_SPACING_MS = 250;

/** Split a mint list into request-sized chunks (order preserved). */
export function chunkMints(mints: string[], size: number = DEFAULT_BATCH_SIZE): string[][] {
  const n = Math.max(1, Math.min(Math.floor(size), 30));
  const out: string[][] = [];
  for (let i = 0; i < mints.length; i += n) out.push(mints.slice(i, i + n));
  return out;
}

/**
 * Fold one batch response into per-mint snapshots.
 *
 * Price, liquidity and chain come from the DEEPEST-LIQUIDITY pair where the
 * mint is the base token (the convention everywhere else in this codebase — see
 * journal/volumeDeath.ts:extractTokenVolumeSnapshot). Market cap is a
 * token-level figure so any pair reporting one is acceptable as a fallback,
 * which matters for tokens whose deepest pool omits it.
 *
 * VOLUME IS THE ONE ADDITIVE FIELD, and it is deliberately not read off the
 * deepest pair. Liquidity, price and chain are PROPERTIES of a pool, so the
 * deepest pool is the honest representative. 24h volume is a FLOW, and a token
 * that trades across a PumpSwap pool and four Meteora pools traded all of it —
 * measured 2026-09-07 on one live mint, the deepest pool carried $9.14M of a
 * $10.7M token total, so reading the deepest pool alone under-reports by ~15%.
 * Under-reporting a floor filter is the direction that silently drops real
 * alerts, so the sum is the only defensible reading.
 *
 * THE SUM IS STILL A FLOOR, NOT A TOTAL, and the 30-pair cap is why. A token
 * whose pools were truncated out of this response contributes only the pools
 * that came back. That biases the figure DOWNWARD, which for a `min` threshold
 * costs a false negative (a missed alert) rather than a false positive (an
 * alert on a token that does not trade) — the same direction every other
 * uncertainty in this pipeline is resolved in.
 *
 * `missing` lists requested mints with no matching pair — either unlisted or
 * lost to the 30-pair cap. The caller disambiguates via `wasTruncated`.
 */
export function snapshotsFromPairs(
  pairs: DexPair[] | null | undefined,
  requested: string[],
): { snapshots: Map<string, MintSnapshot>; missing: string[] } {
  const snapshots = new Map<string, MintSnapshot>();
  const byMint = new Map<string, DexPair[]>();
  for (const p of pairs ?? []) {
    const addr = p.baseToken?.address;
    if (!addr) continue;
    const list = byMint.get(addr) ?? [];
    list.push(p);
    byMint.set(addr, list);
  }

  for (const mint of requested) {
    const matching = byMint.get(mint);
    if (!matching || matching.length === 0) continue;
    const sorted = [...matching].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = sorted[0];
    const price = best.priceUsd != null ? Number(best.priceUsd) : NaN;
    // Token-level number: prefer the deepest pair's marketCap, then its fdv,
    // then the first pair (deepest-first) that reports either.
    let mcapRaw: number | undefined;
    for (const p of sorted) {
      const candidate = p.marketCap ?? p.fdv;
      if (typeof candidate === 'number') {
        mcapRaw = candidate;
        break;
      }
    }
    const liq = best.liquidity?.usd;

    // Additive across pools, and null-unless-somebody-said. `seen` is what
    // separates "every pool reported 0" (a real zero — the token is listed and
    // dead) from "no pool reported anything" (unknown, which must abstain).
    let volume = 0;
    let seen = false;
    for (const p of sorted) {
      const v = p.volume?.h24;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        volume += v;
        seen = true;
      }
    }

    // Pool age comes from the OLDEST pool (the min creation time), because the
    // honest "how long has this been tradeable" is the first pool, not the
    // deepest one — a mature token that opened a fresh deep pool is still
    // mature. Silence stays null rather than collapsing to "brand new".
    let oldestCreatedAt: number | null = null;
    for (const p of sorted) {
      const created = num(p.pairCreatedAt);
      if (created != null && created > 0) {
        oldestCreatedAt = oldestCreatedAt == null ? created : Math.min(oldestCreatedAt, created);
      }
    }

    snapshots.set(mint, {
      mint,
      symbol: best.baseToken?.symbol ?? null,
      priceUsd: Number.isFinite(price) && price > 0 ? price : null,
      mcapUsd: typeof mcapRaw === 'number' && Number.isFinite(mcapRaw) && mcapRaw > 0 ? mcapRaw : null,
      liquidityUsd: typeof liq === 'number' && Number.isFinite(liq) && liq >= 0 ? liq : null,
      volume24hUsd: seen ? volume : null,
      priceChangeH24: pctToFraction(best.priceChange?.h24),
      priceChangeH6: pctToFraction(best.priceChange?.h6),
      pairCreatedAtMs: oldestCreatedAt,
      chainId: typeof best.chainId === 'string' && best.chainId !== '' ? best.chainId : null,
    });
  }

  const missing = requested.filter((m) => !snapshots.has(m));
  return { snapshots, missing };
}

/**
 * True when a response plausibly hit the 30-pair cap, i.e. mints may have been
 * dropped rather than being unlisted. Only meaningful alongside a non-empty
 * `missing` list.
 */
export function wasTruncated(pairCount: number): boolean {
  return pairCount >= DEX_PAIR_CAP;
}

/**
 * Halve a truncated batch for re-query. A singleton cannot be split further —
 * an empty result for it is a real "not listed", so it returns [] and the
 * caller stops.
 */
export function splitForRetry(mints: string[]): string[][] {
  if (mints.length <= 1) return [];
  const mid = Math.ceil(mints.length / 2);
  return [mints.slice(0, mid), mints.slice(mid)];
}

// --- The I/O half -----------------------------------------------------------

export interface DexBatchOptions {
  /** Mints per request. Clamped to 1..30 by chunkMints. */
  batchSize?: number;
  /** Gap between requests, ms. */
  spacingMs?: number;
  /** Log prefix, e.g. '[PriceAlerts]'. Names the subsystem in rate-limit warnings. */
  label: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One batch request. Null means the request itself failed (abstain). */
async function fetchBatch(mints: string[], label: string): Promise<DexPair[] | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 429) console.warn(`${label} DexScreener rate-limited (429).`);
      return null;
    }
    const body = (await res.json()) as { pairs?: DexPair[] };
    return body.pairs ?? [];
  } catch (err) {
    console.warn(`${label} DexScreener fetch failed:`, (err as Error).message);
    return null;
  }
}

/**
 * Read every mint, honouring the 30-pair response cap.
 *
 * Batch, then re-query the halves of any batch that came back AT the cap with
 * mints unaccounted for. Mints missing from a singleton response are genuinely
 * unlisted and are simply absent from the returned map — the caller abstains on
 * them rather than treating absence as a value.
 *
 * A failed request is a data GAP, not an answer: those mints are absent too,
 * and the caller must not write anything for them.
 */
export async function readDexSnapshots(
  mints: string[],
  opts: DexBatchOptions,
): Promise<Map<string, MintSnapshot>> {
  const out = new Map<string, MintSnapshot>();
  const spacing = opts.spacingMs ?? DEFAULT_REQUEST_SPACING_MS;
  const queue = chunkMints(mints, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  let first = true;

  while (queue.length > 0) {
    const batch = queue.shift() as string[];
    if (!first) await sleep(spacing);
    first = false;

    const pairs = await fetchBatch(batch, opts.label);
    if (pairs === null) continue; // request failure = data gap, abstain
    const { snapshots, missing } = snapshotsFromPairs(pairs, batch);
    for (const [mint, snap] of snapshots) out.set(mint, snap);

    // Only a CAPPED response can have hidden a listed token; anything else
    // means those mints really have no pair.
    if (missing.length > 0 && wasTruncated(pairs.length)) {
      for (const half of splitForRetry(missing)) queue.push(half);
    }
  }
  return out;
}
