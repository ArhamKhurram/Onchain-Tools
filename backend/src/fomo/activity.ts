// Normalizers for a single trader's `/v2/users/{id}/activity` feed.
//
// Distinct from store.ts's normalizeUserActivity, which shapes the SAME
// endpoint into a live-feed trade event (NormalizedTrade) for the poller:
// that path is push-oriented, keeps only swaps, and needs a dedupe cursor.
// This path is a pull-oriented history read for the Traders tab, so it keeps
// transfers too and carries the fields a human reads (provider, quote leg,
// explorer link) rather than the ones the feed dedupes on.
//
// Everything here is pure — no I/O — so the discrimination and direction rules
// are unit-testable (see backend/test/fomoTraderActivity.test.ts).

import type {
  BotSwapDirection,
  BotTraderActivityEntry,
  BotTraderActivitySummary,
  BotTraderSwap,
  BotTraderTransfer,
} from '@oct/shared';
import { isQuoteToken } from './store.js';
import { EXPLORER_BASE } from './types.js';

/**
 * Hard ceiling fomo.family enforces on `?limit=`. 101 returns HTTP 400
 * `ERR_VALIDATION_FAILED: "Number must be less than or equal to 100"`.
 *
 * There is NO working pagination past this. The response carries a
 * `hasNextPage` boolean but nothing advances the window — these parameter
 * names were all tried against a live account and every one returned the
 * identical newest page:
 *
 *   offset, page, before, cursor, endDate, to, beforeDate
 *
 * So `hasNextPage: true` is surfaced as `truncated` and shown to the user as
 * "most recent N only" rather than being papered over with a fake next-page
 * control. Don't re-derive this; if fomo.family ever documents a real cursor,
 * that is the moment to revisit.
 */
export const FOMO_ACTIVITY_MAX_LIMIT = 100;

export const FOMO_ACTIVITY_DEFAULT_LIMIT = 100;

/** Clamp a caller-supplied limit into the range the upstream actually accepts. */
export function clampActivityLimit(limit: number | undefined | null): number {
  if (limit == null || !Number.isFinite(limit)) return FOMO_ACTIVITY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), FOMO_ACTIVITY_MAX_LIMIT);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Token explorer URL for an address on a FOMO network, or null when unmapped. */
export function activityExplorerUrl(
  tokenAddress: string | null,
  networkId: number | null,
): string | null {
  if (!tokenAddress || networkId == null) return null;
  const base = EXPLORER_BASE[networkId];
  return base ? `${base}${tokenAddress}` : null;
}

/**
 * Buy vs sell for a swap. fomo.family sends no side field, so direction is
 * derived from which leg is a quote/settlement token (stablecoin or wrapped
 * native — see isQuoteToken in store.ts):
 *
 *   quote → token   buy
 *   token → quote   sell
 *   token → token   swap   (a rotation between two positions, not a side)
 *   quote → quote   swap   (a stable/native rotation, not a side)
 *
 * The two non-directional cases collapse to 'swap' deliberately: labelling
 * either of them buy or sell would misstate what the trader did, and dropping
 * them would make the summary counts lie about the window.
 */
export function deriveSwapDirection(
  inTokenAddress: string | null | undefined,
  outTokenAddress: string | null | undefined,
): BotSwapDirection {
  const inIsQuote = isQuoteToken(inTokenAddress);
  const outIsQuote = isQuoteToken(outTokenAddress);
  if (inIsQuote && !outIsQuote) return 'buy';
  if (!inIsQuote && outIsQuote) return 'sell';
  return 'swap';
}

/**
 * Which leg of the swap is the token the trader is taking a view on. A buy
 * ends holding the `out` leg; a sell started from the `in` leg. Non-directional
 * swaps take `out` — what they ended up with.
 */
function subjectLeg(direction: BotSwapDirection): 'in' | 'out' {
  return direction === 'sell' ? 'in' : 'out';
}

/**
 * Which record shape this is. fomo.family discriminates on `activityType`;
 * anything we don't recognise is dropped rather than guessed at, so a new
 * vendor record type shows up as a shorter list instead of a mislabelled row.
 */
export function activityKind(raw: unknown): 'swap' | 'transfer' | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = str((raw as { activityType?: unknown }).activityType);
  if (type === 'swap') return 'swap';
  if (type === 'transfer') return 'transfer';
  return null;
}

function normalizeSwap(r: Record<string, any>): BotTraderSwap | null {
  const inToken = str(r.inTokenAddress);
  const outToken = str(r.outTokenAddress);
  if (!inToken && !outToken) return null;

  const direction = deriveSwapDirection(inToken, outToken);
  const subject = subjectLeg(direction);

  const tokenAddress = subject === 'in' ? inToken : outToken;
  const quoteTokenAddress = subject === 'in' ? outToken : inToken;
  const subjectNetworkId = num(
    subject === 'in' ? r.inNetworkId : r.outNetworkId,
    r.networkId,
    subject === 'in' ? r.outNetworkId : r.inNetworkId,
  );

  // The settlement leg carries the meaningful USD size: what was spent on a
  // buy, what came back on a sell. Fall back to the other leg when absent.
  const usdIn = num(r.humanUsdAmountIn);
  const usdOut = num(r.humanUsdAmountOut);
  const usdValue = direction === 'sell' ? (usdOut ?? usdIn) : (usdIn ?? usdOut);

  return {
    kind: 'swap',
    id: str(r.id) ?? str(r.inTradeId) ?? str(r.outTradeId),
    at: str(r.createdAt),
    direction,
    tokenAddress,
    tokenSymbol:
      str(subject === 'in' ? r.inTokenSymbol : r.outTokenSymbol) ??
      str((subject === 'in' ? r.inToken : r.outToken)?.symbol) ??
      null,
    quoteTokenAddress,
    networkId: subjectNetworkId,
    usdValue,
    provider: str(r.provider),
    explorerUrl: activityExplorerUrl(tokenAddress, subjectNetworkId),
  };
}

function normalizeTransfer(r: Record<string, any>): BotTraderTransfer | null {
  const tokenAddress = str(r.tokenAddress);
  const networkId = num(r.networkId);
  return {
    kind: 'transfer',
    id: str(r.id),
    at: str(r.createdAt),
    transferType: str(r.type),
    tokenAddress,
    tokenSymbol: str(r.tokenMetadata?.symbol),
    networkId,
    amount: num(r.humanAmount),
    usdValue: num(r.usdAmount),
    fromAddress: str(r.fromAddress),
    toAddress: str(r.toAddress),
    explorerUrl: activityExplorerUrl(tokenAddress, networkId),
  };
}

/** Shape one raw activity record. Returns null for record types we don't model. */
export function normalizeActivityEntry(raw: unknown): BotTraderActivityEntry | null {
  const kind = activityKind(raw);
  if (!kind) return null;
  const r = raw as Record<string, any>;
  return kind === 'swap' ? normalizeSwap(r) : normalizeTransfer(r);
}

/** Pull the activity array + `hasNextPage` out of the response envelope. */
export function extractActivityEnvelope(json: unknown): {
  activities: unknown[];
  hasNextPage: boolean;
} {
  if (Array.isArray(json)) return { activities: json, hasNextPage: false };
  if (!json || typeof json !== 'object') return { activities: [], hasNextPage: false };
  const obj = (json as { responseObject?: any }).responseObject;
  if (!obj || typeof obj !== 'object') return { activities: [], hasNextPage: false };
  return {
    activities: Array.isArray(obj.activities) ? obj.activities : [],
    hasNextPage: obj.hasNextPage === true,
  };
}

/**
 * Roll a window of entries into the headline numbers. Buy/sell totals cover
 * directional swaps only — token↔token rotations have no side and are counted
 * in `swapCount` but excluded from both USD sums, so the two never overstate
 * what actually entered or left a position.
 */
export function summarizeTraderActivity(
  entries: readonly BotTraderActivityEntry[],
): BotTraderActivitySummary {
  let swapCount = 0;
  let transferCount = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  let fromAt: string | null = null;
  let toAt: string | null = null;
  // Compared as epoch ms, not lexically: the vendor's timestamps are ISO UTC
  // today, but a mixed-offset string would sort wrong under a plain compare.
  let fromMs = Number.POSITIVE_INFINITY;
  let toMs = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (entry.kind === 'swap') {
      swapCount += 1;
      if (entry.direction === 'buy') buyUsd += entry.usdValue ?? 0;
      else if (entry.direction === 'sell') sellUsd += entry.usdValue ?? 0;
    } else {
      transferCount += 1;
    }
    if (!entry.at) continue;
    const ms = Date.parse(entry.at);
    if (!Number.isFinite(ms)) continue;
    if (ms < fromMs) {
      fromMs = ms;
      fromAt = entry.at;
    }
    if (ms > toMs) {
      toMs = ms;
      toAt = entry.at;
    }
  }

  return { swapCount, transferCount, buyUsd, sellUsd, fromAt, toAt };
}
