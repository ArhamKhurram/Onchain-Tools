/**
 * Helius Enhanced Transactions client for journal ingestion.
 *
 * The journal reuses the backend's existing Helius credential exactly as the
 * balance checker reads it: plain `HELIUS_API_KEY` (that is how every existing
 * Helius call site reads it — no OCT_/TRENCHCORD_ prefix in this codebase).
 * SECURITY: the key rides in the URL query string, so URLs are NEVER logged —
 * errors log status codes and a static label only.
 *
 * Pagination walks newest→oldest via `before=<signature>`; the pure
 * `collectNewTransactions` decides where the cursor cut is so the logic is
 * unit-testable without the network (journalHelius.test.ts).
 */

import type { HeliusEnhancedTx } from './normalize.js';

const PAGE_LIMIT = 100;
/** Polite pacing between Helius pages. */
const PAGE_SPACING_MS = 300;

export function getHeliusApiKey(): string | null {
  const key = process.env.HELIUS_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export interface CollectResult {
  /** Transactions newer than the cursor, newest-first (as Helius returns). */
  fresh: HeliusEnhancedTx[];
  /** True when the cursor signature was found (history is contiguous). */
  cursorFound: boolean;
}

/**
 * Cut a newest-first page at the last-seen signature. Pure: given one page and
 * the cursor, return the transactions that are new plus whether the cursor was
 * reached (if not, the caller keeps paginating up to its page cap).
 */
export function cutAtCursor(
  page: HeliusEnhancedTx[],
  lastSignature: string | null,
): CollectResult {
  if (!lastSignature) return { fresh: page, cursorFound: false };
  const idx = page.findIndex((tx) => tx.signature === lastSignature);
  if (idx === -1) return { fresh: page, cursorFound: false };
  return { fresh: page.slice(0, idx), cursorFound: true };
}

async function fetchPage(
  address: string,
  apiKey: string,
  before: string | null,
): Promise<HeliusEnhancedTx[] | null> {
  let url =
    `https://api.helius.xyz/v0/addresses/${address}/transactions` +
    `?api-key=${apiKey}&limit=${PAGE_LIMIT}`;
  if (before) url += `&before=${before}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status >= 500) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        console.warn(`[Journal] Helius transactions request failed: HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as unknown;
      return Array.isArray(body) ? (body as HeliusEnhancedTx[]) : [];
    } catch (err) {
      console.warn('[Journal] Helius request error:', (err as Error).message);
      await sleep(1_000 * (attempt + 1));
    }
  }
  return null;
}

export interface FetchNewResult {
  /** New transactions since the cursor, newest-first. */
  transactions: HeliusEnhancedTx[];
  /** Newest signature seen (the next cursor), or null when nothing returned. */
  newestSignature: string | null;
  /** Pages actually requested (request-budget observability). */
  pagesFetched: number;
  /** True when the page cap cut the walk before reaching the cursor. */
  truncated: boolean;
}

/**
 * Fetch transactions for `address` newer than `lastSignature`, walking at most
 * `maxPages` pages. With no cursor (a freshly added wallet) this doubles as
 * the capped history backfill. Returns null on hard failure (caller keeps the
 * old cursor and retries next cycle).
 */
export async function fetchNewTransactions(
  address: string,
  lastSignature: string | null,
  maxPages: number,
): Promise<FetchNewResult | null> {
  const apiKey = getHeliusApiKey();
  if (!apiKey) return null;

  const collected: HeliusEnhancedTx[] = [];
  let before: string | null = null;
  let pagesFetched = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchPage(address, apiKey, before);
    if (batch === null) {
      // Hard failure mid-walk: do NOT advance the cursor over a gap.
      return null;
    }
    pagesFetched += 1;
    if (batch.length === 0) break;

    const { fresh, cursorFound } = cutAtCursor(batch, lastSignature);
    collected.push(...fresh);
    if (cursorFound) break;

    before = batch[batch.length - 1].signature;
    if (batch.length < PAGE_LIMIT) break;
    if (page === maxPages - 1) truncated = true;
    await sleep(PAGE_SPACING_MS);
  }

  return {
    transactions: collected,
    newestSignature: collected.length > 0 ? collected[0].signature : lastSignature,
    pagesFetched,
    truncated,
  };
}

/**
 * Resolve token symbols via Helius DAS getAssetBatch (≤100 mints/request).
 * Best-effort: failures return whatever resolved so far.
 */
export async function resolveTokenSymbols(mints: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const apiKey = getHeliusApiKey();
  if (!apiKey || mints.length === 0) return out;

  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    try {
      const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'oct-journal',
          method: 'getAssetBatch',
          params: { ids: chunk },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        result?: ({ id?: string; content?: { metadata?: { symbol?: string } }; token_info?: { symbol?: string } } | null)[];
      };
      for (const asset of json.result ?? []) {
        if (!asset?.id) continue;
        const sym = asset.content?.metadata?.symbol ?? asset.token_info?.symbol;
        if (sym) out.set(asset.id, String(sym).trim());
      }
    } catch (err) {
      console.warn('[Journal] Symbol batch failed:', (err as Error).message);
    }
    if (i + 100 < mints.length) await sleep(PAGE_SPACING_MS);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
