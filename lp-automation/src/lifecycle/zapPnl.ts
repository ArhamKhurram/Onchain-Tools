// Post-receipt PnL enrichment for enter/increase zap flows.

import type { OutcomeSnapshotExtra } from '../audit/log.js';
import type { LpPosition } from '../types.js';
import { sleep } from './lineage.js';
import type { OutcomeEnrichmentRequest } from './executor.js';
import type { PositionFeed } from './types.js';

export interface ZapPnlEnrichmentDeps {
  positions: PositionFeed;
  lineagePollDelaysMs: readonly number[];
  knownTokenIds: ReadonlySet<string>;
  parseMintFromReceipt?: (txHash: string) => Promise<string | null>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export async function enrichZapOutcomeSnapshot(
  request: OutcomeEnrichmentRequest,
  deps: ZapPnlEnrichmentDeps,
): Promise<OutcomeSnapshotExtra> {
  if (request.action !== 'enter' && request.action !== 'increase') return {};

  const preValue = request.preValueUsd;

  if (request.action === 'increase') {
    const refreshed = await refreshPosition(request.position.tokenId, deps);
    if (refreshed === undefined) {
      deps.warn('lp-lifecycle: increase succeeded but position was not found after refresh', {
        tokenId: request.position.tokenId,
      });
      return {};
    }
    const extra: OutcomeSnapshotExtra = { valueUsd: refreshed.valueUsd };
    const deposit = refreshed.valueUsd - preValue;
    if (deposit > 0) extra.depositValueUsd = deposit;
    return extra;
  }

  const minted = await findEnterMintedPosition(
    request.position.pool.address,
    request.txHash,
    request.position.tokenId,
    deps,
  );
  if (minted !== undefined) {
    const extra: OutcomeSnapshotExtra = {
      mintedTokenId: minted.tokenId,
      valueUsd: minted.valueUsd,
    };
    const deposit = minted.valueUsd - preValue;
    if (deposit > 0) extra.depositValueUsd = deposit;
    return extra;
  }

  const receiptTokenId =
    deps.parseMintFromReceipt === undefined ? null : await deps.parseMintFromReceipt(request.txHash);
  if (receiptTokenId !== null) return { mintedTokenId: receiptTokenId };

  deps.warn('lp-lifecycle: enter succeeded but no new position was found after refresh', {
    pool: request.position.pool.address,
    txHash: request.txHash,
  });
  return {};
}

async function refreshPosition(tokenId: string, deps: ZapPnlEnrichmentDeps): Promise<LpPosition | undefined> {
  try {
    const positions = await deps.positions.loadPositions();
    return positions.find((candidate) => candidate.tokenId === tokenId);
  } catch (error) {
    deps.warn('lp-lifecycle: could not refresh positions for zap PnL snapshot', {
      tokenId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function findEnterMintedPosition(
  poolAddress: string,
  txHash: string,
  excludeTokenId: string,
  deps: ZapPnlEnrichmentDeps,
): Promise<LpPosition | undefined> {
  const pool = poolAddress.toLowerCase();
  const receiptTokenId =
    deps.parseMintFromReceipt === undefined ? null : await deps.parseMintFromReceipt(txHash);

  const pollSchedule = [0, ...deps.lineagePollDelaysMs];
  for (let attempt = 0; attempt < pollSchedule.length; attempt += 1) {
    const delayMs = pollSchedule[attempt] ?? 0;
    if (delayMs > 0) await sleep(delayMs);

    let positions: LpPosition[];
    try {
      positions = await deps.positions.loadPositions();
    } catch (error) {
      deps.warn('lp-lifecycle: could not refresh positions for enter PnL snapshot', {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (receiptTokenId !== null) {
      const fromReceipt = positions.find((candidate) => candidate.tokenId === receiptTokenId);
      if (fromReceipt !== undefined) return fromReceipt;
    }

    const newest = positions
      .filter(
        (candidate) =>
          candidate.pool.address.toLowerCase() === pool &&
          candidate.status !== 'closed' &&
          candidate.tokenId !== excludeTokenId &&
          !deps.knownTokenIds.has(candidate.tokenId),
      )
      .sort((a, b) => Number.parseInt(b.tokenId, 10) - Number.parseInt(a.tokenId, 10))[0];
    if (newest !== undefined) return newest;
  }

  return undefined;
}
