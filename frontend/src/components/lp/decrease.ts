// Remove liquidity from an EXISTING position — pure logic behind LpDecreaseForm.

import type { LpPositionView } from './positions';
import { normalizeAddress } from './selection';
import {
  DEFAULT_SWAP_SLIPPAGE,
  MAX_SWAP_SLIPPAGE,
  parseSlippagePercent,
  toBaseUnits,
  type LpEnterFieldIssue,
  type LpEnterPoolToken,
} from './enter';

export type { LpEnterFieldIssue as LpDecreaseFieldIssue };
export type LpDecreaseMode = 'percent' | 'amount';

export interface LpDecreaseRequest {
  poolAddress: string;
  tokenOutAddress: string;
  liquidityPercent?: number;
  amountOut?: string;
  swapSlippage: number;
}

export interface LpDecreaseCommand {
  id: string;
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'skipped' | 'unknown';
  requestedAt: string | null;
  txHash: string | null;
  error: string | null;
}

export interface LpDecreaseFormValues {
  tokenOutAddress: string;
  mode: LpDecreaseMode;
  percent: string;
  amount: string;
  slippagePercent: string;
}

function poolToken(position: LpPositionView, address: string): LpEnterPoolToken | null {
  const needle = normalizeAddress(address);
  if (!needle) return null;
  const t0 = position.token0;
  const t1 = position.token1;
  if (t0 && normalizeAddress(t0.address) === needle && typeof t0.decimals === 'number') {
    return { symbol: t0.symbol || '???', address: t0.address, decimals: t0.decimals };
  }
  if (t1 && normalizeAddress(t1.address) === needle && typeof t1.decimals === 'number') {
    return { symbol: t1.symbol || '???', address: t1.address, decimals: t1.decimals };
  }
  return null;
}

function parsePercentFraction(raw: string): { ok: true; fraction: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a percent.' };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    return { ok: false, error: 'Percent must be between 0 and 100.' };
  }
  return { ok: true, fraction: value / 100 };
}

export function validateDecreaseForm(
  values: LpDecreaseFormValues,
  position: LpPositionView | null,
): { issues: LpEnterFieldIssue[]; request: LpDecreaseRequest | null } {
  const issues: LpEnterFieldIssue[] = [];
  if (!position) {
    issues.push({ field: 'position', message: 'No position selected.' });
    return { issues, request: null };
  }
  const poolAddress = normalizeAddress(position.poolAddress);
  if (!poolAddress) {
    issues.push({ field: 'poolAddress', message: 'Position has no pool address.' });
    return { issues, request: null };
  }
  const tokenOut = poolToken(position, values.tokenOutAddress);
  if (!tokenOut) issues.push({ field: 'tokenOutAddress', message: 'Select the token to receive.' });

  let liquidityPercent: number | undefined;
  let amountOut: string | undefined;
  if (values.mode === 'percent') {
    const parsed = parsePercentFraction(values.percent);
    if (!parsed.ok) issues.push({ field: 'percent', message: parsed.error });
    else liquidityPercent = parsed.fraction;
  } else if (tokenOut) {
    const converted = toBaseUnits(values.amount, tokenOut.decimals);
    if (!converted.ok) issues.push({ field: 'amount', message: converted.error });
    else amountOut = converted.value;
  } else if (values.amount.trim() === '') {
    issues.push({ field: 'amount', message: 'Enter an amount.' });
  }

  const slippage = parseSlippagePercent(values.slippagePercent);
  let swapSlippage = DEFAULT_SWAP_SLIPPAGE;
  if (!slippage.ok) issues.push({ field: 'swapSlippage', message: slippage.error });
  else swapSlippage = slippage.fraction;

  if (issues.length > 0 || !tokenOut) return { issues, request: null };
  return {
    issues,
    request: {
      poolAddress,
      tokenOutAddress: tokenOut.address,
      ...(liquidityPercent !== undefined ? { liquidityPercent } : {}),
      ...(amountOut !== undefined ? { amountOut } : {}),
      swapSlippage,
    },
  };
}

export function decreaseIssuesByField(issues: readonly LpEnterFieldIssue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of issues) if (!(issue.field in map)) map[issue.field] = issue.message;
  return map;
}

const DECREASE_STATUSES = new Set(['pending', 'claimed', 'done', 'failed', 'skipped']);

export function parseDecreaseCommand(raw: unknown): LpDecreaseCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const nested = 'command' in record ? record.command : record;
  if (!nested || typeof nested !== 'object') return null;
  const r = nested as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.trim() !== '' ? r.id : null;
  if (!id) return null;
  const statusRaw = typeof r.status === 'string' ? r.status : 'unknown';
  const status = (DECREASE_STATUSES.has(statusRaw) ? statusRaw : 'unknown') as LpDecreaseCommand['status'];
  return {
    id,
    status,
    requestedAt: typeof r.requestedAt === 'string' ? r.requestedAt : null,
    txHash: typeof r.txHash === 'string' && r.txHash.trim() !== '' ? r.txHash : null,
    error: typeof r.error === 'string' && r.error.trim() !== '' ? r.error : null,
  };
}

export { DEFAULT_SWAP_SLIPPAGE, MAX_SWAP_SLIPPAGE };
