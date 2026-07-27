// Lineage-keyed PnL derived from the append-only audit log (LP_DASHBOARD_PLAN.md item 4).
//
// Pure — no I/O. The backend reads the same JSONL and runs these functions so the
// dashboard shows cost basis that survives rebalances without a second ledger table.

/** Minimal audit record shape — matches `audit/log.ts` on disk. */
export interface AuditRecordLike {
  id: string;
  phase: 'intent' | 'success' | 'failure';
  timestamp: number;
  action: string;
  rule: string;
  snapshot: Record<string, unknown>;
  txHash: string | null;
  error: string | null;
}

/** Explicit mint→burn link written after a successful rebalance. */
export interface LineageLink {
  oldTokenId: string;
  newTokenId: string;
  poolAddress: string;
  withdrawnValueUsd: number | null;
  remintedValueUsd: number | null;
  timestamp: number;
}

export interface LineagePnlInput {
  /** Normalized pool address — lineage key when no explicit links exist. */
  lineageKey: string;
  /** Open head position token id for this farm. */
  headTokenId: string;
  /** Every token id in this lineage, head first when known. */
  memberTokenIds: string[];
  /** Live position value (Krystal display feed). */
  currentValueUsd: number;
  /** Unclaimed fees on the head position. */
  unclaimedFeesUsd: number;
}

export interface LineagePnl {
  lineageKey: string;
  headTokenId: string;
  memberTokenIds: string[];
  costBasisUsd: number | null;
  /** False when the farm predates value recording — PnL is since first observation. */
  costBasisKnown: boolean;
  /** ISO date label when cost basis is approximate ("since YYYY-MM-DD"). */
  costBasisSince: string | null;
  currentValueUsd: number;
  unclaimedFeesUsd: number;
  /** Sum of unclaimed fees at each successful compound (informational). */
  lifetimeFeesUsd: number;
  gasPaidUsd: number;
  netPnlUsd: number | null;
  netPnlPercent: number | null;
}

/** Options for deriving PnL from audit records. */
export interface PnlDerivationOptions {
  /** Used when snapshots omit nativeTokenUsd (historical enter/increase rows). */
  fallbackNativeTokenUsd?: number | null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function snapshotString(snapshot: Record<string, unknown>, key: string): string | null {
  const raw = snapshot[key];
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

function normalizeAddress(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^0x[0-9a-f]{40}$/.test(text) ? text : null;
}

function normalizeTokenId(raw: unknown): string | null {
  const text = snapshotString({ v: raw }, 'v');
  if (!text) return null;
  return text.replace(/^#/, '');
}

/** Gas actually spent, stored on outcome snapshots after broadcast. */
export function gasSpentUsdFromSnapshot(snapshot: Record<string, unknown>): number {
  const direct = finite(snapshot.gasSpentUsd);
  if (direct !== null && direct >= 0) return direct;

  const gasUsedRaw = snapshot.gasUsed;
  const priceRaw = snapshot.effectiveGasPriceWei;
  const nativeUsd = finite(snapshot.nativeTokenUsd);
  if (nativeUsd === null || nativeUsd <= 0) return 0;

  let gasUsed: bigint;
  let price: bigint;
  try {
    gasUsed = BigInt(typeof gasUsedRaw === 'string' || typeof gasUsedRaw === 'number' ? gasUsedRaw : 0);
    price = BigInt(typeof priceRaw === 'string' || typeof priceRaw === 'number' ? priceRaw : 0);
  } catch {
    return 0;
  }
  if (gasUsed <= 0n || price <= 0n) return 0;

  const wei = gasUsed * price;
  const eth = Number(wei) / 1e18;
  if (!Number.isFinite(eth)) return 0;
  return eth * nativeUsd;
}

export function extractLineageLinks(records: readonly AuditRecordLike[]): LineageLink[] {
  const links: LineageLink[] = [];
  for (const record of records) {
    if (record.rule !== 'lifecycle.rebalance.lineage') continue;
    const oldTokenId = normalizeTokenId(record.snapshot.oldTokenId);
    const newTokenId = normalizeTokenId(record.snapshot.newTokenId);
    const poolAddress = normalizeAddress(record.snapshot.pool ?? record.snapshot.poolAddress);
    if (!oldTokenId || !newTokenId || !poolAddress) continue;
    links.push({
      oldTokenId,
      newTokenId,
      poolAddress,
      withdrawnValueUsd: finite(record.snapshot.withdrawnValueUsd),
      remintedValueUsd: finite(record.snapshot.remintedValueUsd),
      timestamp: record.timestamp,
    });
  }
  return links;
}

/** Walk explicit old→new links to collect every token id in a lineage chain. */
export function lineageMembersFromLinks(
  headTokenId: string,
  links: readonly LineageLink[],
): string[] {
  const byNew = new Map<string, string>();
  for (const link of links) {
    byNew.set(link.newTokenId, link.oldTokenId);
  }

  const members: string[] = [headTokenId];
  let cursor = headTokenId;
  const seen = new Set<string>([headTokenId]);
  while (byNew.has(cursor)) {
    const prev = byNew.get(cursor)!;
    if (seen.has(prev)) break;
    members.push(prev);
    seen.add(prev);
    cursor = prev;
  }
  return members;
}

function isSuccessfulAction(record: AuditRecordLike): boolean {
  return record.phase === 'success' && record.error === null && record.action !== 'none';
}

function tokenIdFromRecord(record: AuditRecordLike): string | null {
  return normalizeTokenId(record.snapshot.tokenId);
}

interface ValueObservation {
  tokenId: string;
  valueUsd: number;
  timestamp: number;
}

function collectValueObservations(
  records: readonly AuditRecordLike[],
  memberTokenIds: ReadonlySet<string>,
): ValueObservation[] {
  const observations: ValueObservation[] = [];
  for (const record of records) {
    const tokenId = tokenIdFromRecord(record);
    if (!tokenId || !memberTokenIds.has(tokenId)) continue;
    const valueUsd = finite(record.snapshot.valueUsd);
    if (valueUsd === null) continue;
    if (record.phase !== 'intent' && record.phase !== 'success') continue;
    observations.push({ tokenId, valueUsd, timestamp: record.timestamp });
  }
  observations.sort((a, b) => a.timestamp - b.timestamp);
  return observations;
}

function sumLifetimeFees(
  records: readonly AuditRecordLike[],
  memberTokenIds: ReadonlySet<string>,
): number {
  let total = 0;
  for (const record of records) {
    if (!isSuccessfulAction(record) || record.action !== 'compound') continue;
    const tokenId = tokenIdFromRecord(record);
    if (!tokenId || !memberTokenIds.has(tokenId)) continue;
    const fees = finite(record.snapshot.unclaimedFeesUsd);
    if (fees !== null && fees > 0) total += fees;
  }
  return total;
}

function sumGasPaid(
  records: readonly AuditRecordLike[],
  memberTokenIds: ReadonlySet<string>,
): number {
  let total = 0;
  for (const record of records) {
    if (!isSuccessfulAction(record)) continue;
    if (!['compound', 'rebalance', 'exit', 'enter', 'increase', 'approve'].includes(record.action)) {
      continue;
    }
    const tokenId = tokenIdFromRecord(record);
    if (!tokenId || !memberTokenIds.has(tokenId)) continue;
    total += gasSpentUsdFromSnapshot(record.snapshot);
  }
  return total;
}

/** Receipt-confirmed outcomes include on-chain gas fields (not estimates). */
function isReceiptConfirmedSnapshot(snapshot: Record<string, unknown>): boolean {
  const gasUsed = snapshot.gasUsed;
  return gasUsed !== undefined && gasUsed !== null && gasUsed !== '' && gasUsed !== 0;
}

function nativeTokenUsdForDeposit(
  snapshot: Record<string, unknown>,
  options: PnlDerivationOptions,
): number | null {
  const fromSnapshot = finite(snapshot.nativeTokenUsd);
  if (fromSnapshot !== null && fromSnapshot > 0) return fromSnapshot;
  const fallback = options.fallbackNativeTokenUsd;
  if (fallback !== null && fallback !== undefined && Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  return null;
}

/** USD deposited via zap-in / zap-increase (explicit field or amountIn × native price). */
export function depositUsdFromSnapshot(
  snapshot: Record<string, unknown>,
  options: PnlDerivationOptions = {},
  trustAmountIn = true,
): number | null {
  const direct =
    finite(snapshot.depositValueUsd) ??
    finite(snapshot.amountInUsd) ??
    finite(snapshot.capitalInUsd);
  if (direct !== null && direct > 0) return direct;

  if (!trustAmountIn) return null;

  const amountIn = snapshot.amountIn;
  const nativeUsd = nativeTokenUsdForDeposit(snapshot, options);
  if (amountIn == null || nativeUsd === null) return null;

  try {
    const wei = BigInt(typeof amountIn === 'string' || typeof amountIn === 'number' ? amountIn : '0');
    if (wei <= 0n) return null;
    const eth = Number(wei) / 1e18;
    if (!Number.isFinite(eth) || eth <= 0) return null;
    return eth * nativeUsd;
  } catch {
    return null;
  }
}

/** First observation after a capital action where position value rose above the pre-tx snapshot. */
function depositFromValueDelta(
  pre: number,
  tokenId: string,
  afterTimestamp: number,
  observations: readonly ValueObservation[],
): number | null {
  const next = observations.find(
    (o) => o.tokenId === tokenId && o.timestamp > afterTimestamp && o.valueUsd > pre,
  );
  if (next === undefined) return null;
  const deposit = next.valueUsd - pre;
  return deposit > 0 ? deposit : null;
}

function canTrustAmountInDeposit(snapshot: Record<string, unknown>): boolean {
  if (isReceiptConfirmedSnapshot(snapshot)) return true;
  const nativeUsd = finite(snapshot.nativeTokenUsd);
  return nativeUsd !== null && nativeUsd > 0;
}

function resolveCapitalDeposit(
  snapshot: Record<string, unknown>,
  options: PnlDerivationOptions,
  receiptConfirmed: boolean,
  tokenId: string,
  afterTimestamp: number,
  observations: readonly ValueObservation[],
): number | null {
  const trustAmountIn = receiptConfirmed || canTrustAmountInDeposit(snapshot);
  let deposit = depositUsdFromSnapshot(snapshot, options, false);
  if (deposit === null && trustAmountIn) {
    deposit = depositUsdFromSnapshot(snapshot, options, true);
  }
  if (deposit === null) {
    const pre = finite(snapshot.valueUsd);
    if (pre !== null) {
      deposit = depositFromValueDelta(pre, tokenId, afterTimestamp, observations);
    }
  }
  return deposit;
}

function parsePoolFromLineageKey(lineageKey: string): string | null {
  const idx = lineageKey.lastIndexOf(':');
  if (idx <= 0) return null;
  return normalizeAddress(lineageKey.slice(0, idx));
}

function isCommandIdToken(tokenId: string): boolean {
  return tokenId.includes('-');
}

function enterAttributedToHead(
  record: AuditRecordLike,
  headTokenId: string,
  poolAddress: string,
  observations: readonly ValueObservation[],
): boolean {
  const recPool = normalizeAddress(record.snapshot.pool ?? record.snapshot.poolAddress);
  if (recPool !== normalizeAddress(poolAddress)) return false;
  const tid = tokenIdFromRecord(record);
  if (tid === headTokenId) return true;
  if (!tid || !isCommandIdToken(tid)) return false;
  const headFirst = observations.find((o) => o.tokenId === headTokenId);
  if (!headFirst) return false;
  return Math.abs(record.timestamp - headFirst.timestamp) < 5 * 60 * 1000;
}

/**
 * Net capital deployed = opening snapshot + deposits (enter/increase) − withdrawals (exit).
 *
 * Opening snapshot is the earliest value observation in the lineage — that anchors
 * rebalance chains so repositioning is not counted as PnL. Only flows *after* that
 * timestamp adjust basis, so a zap-in that created the position is not double-counted.
 */
function computeNetCapitalDeployed(
  records: readonly AuditRecordLike[],
  memberTokenIds: ReadonlySet<string>,
  headTokenId: string,
  poolAddress: string | null,
  observations: readonly ValueObservation[],
  options: PnlDerivationOptions,
): { costBasisUsd: number | null; costBasisKnown: boolean; costBasisSince: string | null } {
  const firstObs = observations[0];
  if (!firstObs) {
    return { costBasisUsd: null, costBasisKnown: false, costBasisSince: null };
  }

  let netCapital = firstObs.valueUsd;
  let hasExplicitFlow = false;
  const baselineTs = firstObs.timestamp;

  const sorted = [...records]
    .filter(isSuccessfulAction)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const record of sorted) {
    if (record.timestamp <= baselineTs) continue;

    const tokenId = tokenIdFromRecord(record);
    const snap = record.snapshot;

    if (record.action === 'increase') {
      if (!tokenId || !memberTokenIds.has(tokenId)) continue;
      const deposit = resolveCapitalDeposit(
        snap,
        options,
        isReceiptConfirmedSnapshot(snap),
        tokenId,
        record.timestamp,
        observations,
      );
      if (deposit !== null && deposit > 0) {
        netCapital += deposit;
        hasExplicitFlow = true;
      }
      continue;
    }

    if (record.action === 'exit') {
      if (!tokenId || !memberTokenIds.has(tokenId)) continue;
      const withdrawal = finite(snap.valueUsd) ?? finite(snap.withdrawnValueUsd);
      if (withdrawal !== null && withdrawal > 0) {
        netCapital -= withdrawal;
        hasExplicitFlow = true;
      }
      continue;
    }

    if (record.action === 'enter' && poolAddress) {
      if (!enterAttributedToHead(record, headTokenId, poolAddress, observations)) continue;
      const deposit = resolveCapitalDeposit(
        snap,
        options,
        isReceiptConfirmedSnapshot(snap),
        headTokenId,
        record.timestamp,
        observations,
      );
      if (deposit !== null && deposit > 0) {
        netCapital += deposit;
        hasExplicitFlow = true;
      }
    }
  }

  return {
    costBasisUsd: Math.max(0, netCapital),
    costBasisKnown: hasExplicitFlow,
    costBasisSince: hasExplicitFlow ? null : new Date(firstObs.timestamp).toISOString().slice(0, 10),
  };
}

/** Derive lifetime PnL for one lineage from audit records + live head values. */
export function deriveLineagePnl(
  records: readonly AuditRecordLike[],
  input: LineagePnlInput,
  options: PnlDerivationOptions = {},
): LineagePnl {
  const memberSet = new Set(input.memberTokenIds);
  const observations = collectValueObservations(records, memberSet);
  const poolAddress = parsePoolFromLineageKey(input.lineageKey);
  const { costBasisUsd, costBasisKnown, costBasisSince } = computeNetCapitalDeployed(
    records,
    memberSet,
    input.headTokenId,
    poolAddress,
    observations,
    options,
  );

  const lifetimeFeesUsd = sumLifetimeFees(records, memberSet);
  const gasPaidUsd = sumGasPaid(records, memberSet);

  let netPnlUsd: number | null = null;
  let netPnlPercent: number | null = null;
  if (costBasisUsd !== null) {
    netPnlUsd =
      input.currentValueUsd + input.unclaimedFeesUsd - costBasisUsd - gasPaidUsd;
    if (costBasisUsd > 0) {
      netPnlPercent = (netPnlUsd / costBasisUsd) * 100;
    }
  }

  return {
    lineageKey: input.lineageKey,
    headTokenId: input.headTokenId,
    memberTokenIds: input.memberTokenIds,
    costBasisUsd,
    costBasisKnown,
    costBasisSince,
    currentValueUsd: input.currentValueUsd,
    unclaimedFeesUsd: input.unclaimedFeesUsd,
    lifetimeFeesUsd,
    gasPaidUsd,
    netPnlUsd,
    netPnlPercent,
  };
}

/** Build lineage PnL rows for every live head in `inputs`. */
export function deriveAllLineagePnl(
  records: readonly AuditRecordLike[],
  inputs: readonly LineagePnlInput[],
  options: PnlDerivationOptions = {},
): LineagePnl[] {
  return inputs.map((input) => deriveLineagePnl(records, input, options));
}
