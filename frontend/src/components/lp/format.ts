// Display formatting for the LP automation console.
//
// Every function here is pure and total: the numbers arrive from an HTTP
// boundary, so `undefined`, `NaN` and `Infinity` all have to render as an em
// dash rather than as "NaN" in a panel that is supposed to inspire confidence
// about real money.

import type { PoolCandidate } from './types';
import type { LpCommandStatus } from './commands';

const DASH = '—';

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `$250`, `$1,250`. Exact — use for policy caps, which are set by hand. */
export function formatUsdExact(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const decimals = abs > 0 && abs < 1 ? 2 : Number.isInteger(n) ? 0 : 2;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Signed dollar PnL with explicit +/− prefix. */
export function formatSignedUsd(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  const formatted = formatUsdExact(Math.abs(n));
  if (n > 0) return `+${formatted}`;
  if (n < 0) return `−${formatted}`;
  return formatted;
}

/** Signed percentage for net PnL %. */
export function formatSignedPercent(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const text = `${abs.toFixed(abs >= 10 ? 1 : 2)}%`;
  if (n > 0) return `+${text}`;
  if (n < 0) return `−${text}`;
  return text;
}

/** Compact — use for market-sourced numbers in tables. */
export function formatUsdCompact(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * `PoolCandidate.feeApr` is a fraction (0.42 = 42%), which is exactly the kind
 * of unit mismatch that silently renders a 42% pool as "0.4%".
 */
export function formatAprFraction(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  return `${(n * 100).toFixed(n * 100 >= 100 ? 0 : 1)}%`;
}

/** A percentage that is already a percentage (policy fields), e.g. `5%`. */
export function formatPercentValue(value: unknown, decimals = 1): string {
  const n = finite(value);
  if (n === null) return DASH;
  return `${n.toFixed(Number.isInteger(n) ? 0 : decimals)}%`;
}

/** 3000 bps → `0.3%`. Uniswap fee tiers. */
export function formatFeeTier(bps: unknown): string {
  const n = finite(bps);
  if (n === null) return DASH;
  const pct = n / 10_000;
  return `${pct.toFixed(pct < 0.01 ? 3 : 2)}%`;
}

export function formatRatio(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  return `${n.toFixed(n % 1 === 0 ? 1 : 2)}×`;
}

/** `24h`, `36h` → `1d 12h`. Used for the compound liveness backstop. */
export function formatHours(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  if (n < 24) return `${Number(n.toFixed(2))}h`;
  const days = Math.floor(n / 24);
  const hours = Number((n % 24).toFixed(2));
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function formatMinutes(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  if (n < 60) return `${Number(n.toFixed(2))} min`;
  const hours = n / 60;
  return `${Number(hours.toFixed(hours % 1 === 0 ? 0 : 1))} h`;
}

/** `0x1234…cdef` — enough to eyeball against a block explorer. */
export function shortAddress(address: string | null | undefined): string {
  if (typeof address !== 'string' || address.length < 12) return address ?? DASH;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function poolPairLabel(pool: Pick<PoolCandidate, 'token0' | 'token1'>): string {
  const a = pool.token0?.symbol?.trim() || '???';
  const b = pool.token1?.symbol?.trim() || '???';
  return `${a} / ${b}`;
}

/**
 * How many full-size entries a daily cap funds. Rendered next to the cap so the
 * two money fields read as one sentence instead of two unrelated numbers.
 */
export function describeDailyCapacity(maxPositionSizeUsd: number, dailySpendCapUsd: number): string {
  if (!Number.isFinite(maxPositionSizeUsd) || maxPositionSizeUsd <= 0) return DASH;
  if (!Number.isFinite(dailySpendCapUsd) || dailySpendCapUsd <= 0) return DASH;
  const entries = dailySpendCapUsd / maxPositionSizeUsd;
  if (entries < 1) return 'not even one full-size entry';
  const whole = Math.floor(entries + 1e-9);
  return `${whole} full-size ${whole === 1 ? 'entry' : 'entries'} per day`;
}

export type LpCommandReceiptStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'reverted'
  | 'skipped';

export const LP_BLOCK_EXPLORER = 'https://robinhoodchain.blockscout.com';

export const RECEIPT_STATUS_LABELS: Record<LpCommandReceiptStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  reverted: 'Reverted',
  skipped: 'Skipped',
};

export const HISTORY_ACTION_LABELS: Record<string, string> = {
  compound: 'Compound',
  rebalance: 'Rebalance',
  compound_rebalance: 'Compound + rebalance',
  increase: 'Add liquidity',
  enter: 'Enter',
  exit: 'Exit',
};

export interface LpCommandHistoryRow {
  id: string;
  tokenId: string | null;
  poolAddress: string | null;
  action: string;
  status: LpCommandStatus;
  requestedAt: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  txHash: string | null;
  error: string | null;
  receiptStatus: LpCommandReceiptStatus;
  txExplorerUrl: string | null;
}

function historyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function historyTokenId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function parseReceiptStatus(value: unknown): LpCommandReceiptStatus | null {
  const statuses = ['pending', 'running', 'done', 'failed', 'reverted', 'skipped'] as const;
  return typeof value === 'string' && statuses.includes(value as LpCommandReceiptStatus)
    ? (value as LpCommandReceiptStatus)
    : null;
}

function deriveReceiptStatus(
  status: LpCommandStatus,
  txHash: string | null,
  error: string | null,
): LpCommandReceiptStatus {
  if (status === 'pending') return 'pending';
  if (status === 'claimed') return 'running';
  if (status === 'done') return 'done';
  if (status === 'skipped') return 'skipped';
  if (status === 'failed') {
    if (error?.trimStart().toLowerCase().startsWith('skipped')) return 'skipped';
    if (txHash && error && /reverted/i.test(error)) return 'reverted';
    return 'failed';
  }
  return 'failed';
}

export function buildTxExplorerUrl(txHash: string | null): string | null {
  return typeof txHash === 'string' && txHash.startsWith('0x')
    ? `${LP_BLOCK_EXPLORER}/tx/${txHash}`
    : null;
}

export function formatCommandTimestamp(iso: string | null): string {
  if (!iso) return DASH;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return DASH;
  return new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function parseHistoryCommand(raw: unknown): LpCommandHistoryRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const actions = new Set(['compound', 'rebalance', 'compound_rebalance', 'increase', 'enter', 'exit']);
  if (typeof record.action !== 'string' || !actions.has(record.action)) return null;

  const id = historyString(record.id);
  if (!id) return null;

  const tokenId = historyTokenId(record.tokenId);
  if (record.action !== 'enter' && tokenId === null) return null;

  const status = typeof record.status === 'string' ? (record.status as LpCommandStatus) : 'unknown';
  const txHash = historyString(record.txHash);
  const error = historyString(record.error);
  const receiptStatus = parseReceiptStatus(record.receiptStatus) ?? deriveReceiptStatus(status, txHash, error);

  return {
    id,
    tokenId: record.action === 'enter' ? null : tokenId,
    poolAddress: historyString(record.poolAddress),
    action: record.action,
    status,
    requestedAt: historyString(record.requestedAt),
    claimedAt: historyString(record.claimedAt),
    completedAt: historyString(record.completedAt),
    txHash,
    error,
    receiptStatus,
    txExplorerUrl: historyString(record.txExplorerUrl) ?? buildTxExplorerUrl(txHash),
  };
}

export function parseHistoryCommands(raw: unknown): LpCommandHistoryRow[] {
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { commands?: unknown }).commands)
      ? (raw as { commands: unknown[] }).commands
      : Array.isArray(raw)
        ? raw
        : [];
  return list
    .map(parseHistoryCommand)
    .filter((entry): entry is LpCommandHistoryRow => entry !== null)
    .sort((a, b) => {
      const aTime = a.requestedAt ? new Date(a.requestedAt).getTime() : 0;
      const bTime = b.requestedAt ? new Date(b.requestedAt).getTime() : 0;
      return bTime - aTime;
    });
}
