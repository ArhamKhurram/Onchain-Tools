// Rebalance lineage: mint→burn links for PnL member sets.

import type { Address, LpPosition } from '../types.js';

export const DEFAULT_LINEAGE_POLL_DELAYS_MS = [2_000, 5_000, 10_000] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface ReceiptLogLike {
  address: string;
  topics: readonly string[];
}

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

function tokenIdNumeric(tokenId: string): number {
  const parsed = Number.parseInt(tokenId, 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function findRebalanceSuccessor(
  positions: readonly LpPosition[],
  oldTokenId: string,
  poolAddress: string,
): LpPosition | undefined {
  const pool = normalizeAddress(poolAddress);
  const oldNumeric = tokenIdNumeric(oldTokenId);
  const candidates = positions.filter((candidate) => {
    if (normalizeAddress(candidate.pool.address) !== pool) return false;
    if (candidate.tokenId === oldTokenId) return false;
    if (candidate.status === 'closed') return false;
    const candidateNumeric = tokenIdNumeric(candidate.tokenId);
    if (!Number.isFinite(oldNumeric) || !Number.isFinite(candidateNumeric)) {
      return candidate.tokenId !== oldTokenId;
    }
    return candidateNumeric > oldNumeric;
  });
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => tokenIdNumeric(b.tokenId) - tokenIdNumeric(a.tokenId))[0];
}

export function parseMintedTokenIdFromLogs(
  logs: readonly ReceiptLogLike[],
  positionManager: Address,
  recipient: Address,
): string | null {
  const manager = normalizeAddress(positionManager);
  const to = normalizeAddress(recipient);
  let best: { tokenId: string; numeric: number } | null = null;
  for (const log of logs) {
    if (normalizeAddress(log.address) !== manager) continue;
    if (log.topics.length < 4) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = log.topics[1]?.toLowerCase() ?? '';
    const dest = log.topics[2]?.toLowerCase() ?? '';
    if (!from.endsWith(ZERO_ADDRESS.slice(2))) continue;
    if (dest !== to && !dest.endsWith(to.slice(2))) continue;
    const tokenId = BigInt(log.topics[3]!).toString(10);
    const numeric = tokenIdNumeric(tokenId);
    if (best === null || numeric > best.numeric) best = { tokenId, numeric };
  }
  return best?.tokenId ?? null;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
