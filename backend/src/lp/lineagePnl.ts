// Build per-position PnL inputs from display positions + explicit rebalance links.
//
// Mirrors frontend `buildLineages`: one input per open row (or one closed-only farm),
// with member token IDs = head + closed rebalance predecessors only — never concurrent
// opens in the same pool.

import type { LpPositionView } from '../api/routes/lp.js';
import type { LineageLink, LineagePnlInput } from './pnl.js';
import { lineageMembersFromLinks } from './pnl.js';

function normalizePool(poolAddress: string): string {
  return poolAddress.trim().toLowerCase();
}

function tokenIdNumeric(tokenId: string): number {
  const n = Number.parseInt(tokenId.replace(/^#/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Stable row key — must match frontend `positionKey`. */
export function positionPnlKey(poolAddress: string, tokenId: string): string {
  return `${normalizePool(poolAddress)}:${String(tokenId)}`;
}

function closedAncestorsWithoutLinks(
  head: LpPositionView,
  members: readonly LpPositionView[],
): LpPositionView[] {
  const opens = members
    .filter((p) => p.status !== 'closed')
    .sort((a, b) => tokenIdNumeric(a.tokenId) - tokenIdNumeric(b.tokenId));
  const headIndex = opens.findIndex((p) => p.tokenId === head.tokenId);

  if (headIndex < 0) {
    return members
      .filter((p) => p.tokenId !== head.tokenId && p.status === 'closed')
      .sort((a, b) => tokenIdNumeric(b.tokenId) - tokenIdNumeric(a.tokenId));
  }

  const lowerBound =
    headIndex === 0 ? 0 : tokenIdNumeric(opens[headIndex - 1]!.tokenId);
  const upperBound = tokenIdNumeric(head.tokenId);

  return members
    .filter((p) => {
      if (p.status !== 'closed') return false;
      const id = tokenIdNumeric(p.tokenId);
      return id > lowerBound && id < upperBound;
    })
    .sort((a, b) => tokenIdNumeric(b.tokenId) - tokenIdNumeric(a.tokenId));
}

function closedAncestorsForHead(
  head: LpPositionView,
  members: readonly LpPositionView[],
  poolLinks: readonly LineageLink[],
): LpPositionView[] {
  if (poolLinks.length > 0) {
    const chain = lineageMembersFromLinks(head.tokenId, poolLinks);
    const ancestorIds = new Set(chain.slice(1));
    return members
      .filter((p) => ancestorIds.has(p.tokenId) && p.status === 'closed')
      .sort((a, b) => chain.indexOf(a.tokenId) - chain.indexOf(b.tokenId));
  }
  return closedAncestorsWithoutLinks(head, members);
}

function memberTokenIdsForHead(
  head: LpPositionView,
  members: readonly LpPositionView[],
  poolLinks: readonly LineageLink[],
): string[] {
  const ancestors = closedAncestorsForHead(head, members, poolLinks);
  return [head.tokenId, ...ancestors.map((a) => a.tokenId)];
}

/**
 * One PnL input per grid row — same grouping as frontend `buildLineages`.
 */
export function buildLineagePnlInputs(
  positions: readonly LpPositionView[],
  links: readonly LineageLink[],
): LineagePnlInput[] {
  const linksByPool = new Map<string, LineageLink[]>();
  for (const link of links) {
    const pool = normalizePool(link.poolAddress);
    const list = linksByPool.get(pool) ?? [];
    list.push(link);
    linksByPool.set(pool, list);
  }

  const byPool = new Map<string, LpPositionView[]>();
  for (const position of positions) {
    const key = normalizePool(position.poolAddress);
    if (!key) continue;
    const list = byPool.get(key) ?? [];
    list.push(position);
    byPool.set(key, list);
  }

  const inputs: LineagePnlInput[] = [];

  for (const [, members] of byPool) {
    const sorted = [...members].sort(
      (a, b) => tokenIdNumeric(b.tokenId) - tokenIdNumeric(a.tokenId),
    );
    const poolLinks = linksByPool.get(normalizePool(sorted[0]!.poolAddress)) ?? [];
    const opens = sorted.filter((p) => p.status !== 'closed');

    if (opens.length === 0) {
      const head = sorted[0]!;
      inputs.push({
        lineageKey: positionPnlKey(head.poolAddress, head.tokenId),
        headTokenId: head.tokenId,
        memberTokenIds: memberTokenIdsForHead(head, sorted, poolLinks),
        currentValueUsd: head.valueUsd,
        unclaimedFeesUsd: head.unclaimedFeesUsd,
      });
      continue;
    }

    for (const head of opens) {
      inputs.push({
        lineageKey: positionPnlKey(head.poolAddress, head.tokenId),
        headTokenId: head.tokenId,
        memberTokenIds: memberTokenIdsForHead(head, sorted, poolLinks),
        currentValueUsd: head.valueUsd,
        unclaimedFeesUsd: head.unclaimedFeesUsd,
      });
    }
  }

  return inputs;
}
