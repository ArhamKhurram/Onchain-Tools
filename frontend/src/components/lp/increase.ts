// Add liquidity to an EXISTING position — pure logic behind LpIncreaseForm.
//
// Same queue → worker → module path as enter and manual actions. Keep in sync
// with `POST /api/lp/positions/:tokenId/increase`.

import type { LpPositionView } from './positions';
import { normalizeAddress } from './selection';
import {
  DEFAULT_SWAP_SLIPPAGE,
  MAX_SWAP_SLIPPAGE,
  NATIVE_ETH_ADDRESS,
  isNativeEthTokenIn,
  parseSlippagePercent,
  toBaseUnits,
  type LpEnterFieldIssue,
  type LpEnterPoolToken,
} from './enter';

export type { LpEnterFieldIssue as LpIncreaseFieldIssue };

export interface LpIncreaseRequest {
  poolAddress: string;
  tokenInAddress: string;
  amountIn: string;
  swapSlippage: number;
}

export interface LpIncreaseCommand {
  id: string;
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'skipped' | 'unknown';
  requestedAt: string | null;
  txHash: string | null;
  error: string | null;
}

export interface LpIncreaseFormValues {
  tokenInAddress: string;
  amount: string;
  slippagePercent: string;
}

function poolToken(position: LpPositionView, address: string): LpEnterPoolToken | null {
  const needle = normalizeAddress(address);
  if (!needle) return null;
  if (isNativeEthTokenIn(needle)) {
    const t0 = position.token0;
    const t1 = position.token1;
    if (t0?.symbol?.toUpperCase() === 'WETH' && typeof t0.decimals === 'number') {
      return { symbol: t0.symbol, address: t0.address, decimals: t0.decimals };
    }
    if (t1?.symbol?.toUpperCase() === 'WETH' && typeof t1.decimals === 'number') {
      return { symbol: t1.symbol, address: t1.address, decimals: t1.decimals };
    }
    return null;
  }
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

export function increaseDepositTokenOptions(position: LpPositionView): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  if (position.token0?.address) {
    options.push({ value: position.token0.address, label: position.token0.symbol || '???' });
  }
  if (position.token1?.address) {
    options.push({ value: position.token1.address, label: position.token1.symbol || '???' });
  }
  const hasWeth = options.some((opt) => opt.label.toUpperCase() === 'WETH');
  if (hasWeth && !options.some((opt) => isNativeEthTokenIn(opt.value))) {
    options.push({ value: NATIVE_ETH_ADDRESS, label: 'ETH' });
  }
  return options;
}

export function validateIncreaseForm(
  values: LpIncreaseFormValues,
  position: LpPositionView | null,
): { issues: LpEnterFieldIssue[]; request: LpIncreaseRequest | null } {
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

  const tokenIn = poolToken(position, values.tokenInAddress);
  if (!tokenIn) {
    issues.push({ field: 'tokenInAddress', message: 'Select the token to deposit.' });
  }

  const tokenInAddress =
    tokenIn && isNativeEthTokenIn(normalizeAddress(values.tokenInAddress) ?? '')
      ? NATIVE_ETH_ADDRESS
      : tokenIn?.address ?? null;

  let amountIn: string | null = null;
  if (tokenIn) {
    const converted = toBaseUnits(values.amount, tokenIn.decimals);
    if (!converted.ok) issues.push({ field: 'amount', message: converted.error });
    else amountIn = converted.value;
  } else if (values.amount.trim() === '') {
    issues.push({ field: 'amount', message: 'Enter an amount.' });
  }

  const slippage = parseSlippagePercent(values.slippagePercent);
  let swapSlippage = DEFAULT_SWAP_SLIPPAGE;
  if (!slippage.ok) issues.push({ field: 'swapSlippage', message: slippage.error });
  else swapSlippage = slippage.fraction;

  if (issues.length > 0 || !tokenIn || amountIn === null || !tokenInAddress) {
    return { issues, request: null };
  }

  return {
    issues,
    request: {
      poolAddress,
      tokenInAddress,
      amountIn,
      swapSlippage,
    },
  };
}

export function increaseIssuesByField(issues: readonly LpEnterFieldIssue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of issues) if (!(issue.field in map)) map[issue.field] = issue.message;
  return map;
}

const INCREASE_STATUSES = new Set(['pending', 'claimed', 'done', 'failed', 'skipped']);

export function parseIncreaseCommand(raw: unknown): LpIncreaseCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const nested = 'command' in record ? record.command : record;
  if (!nested || typeof nested !== 'object') return null;
  const r = nested as Record<string, unknown>;

  const id = typeof r.id === 'string' && r.id.trim() !== '' ? r.id : null;
  if (!id) return null;

  const statusRaw = typeof r.status === 'string' ? r.status : 'unknown';
  const status = (
    INCREASE_STATUSES.has(statusRaw) ? statusRaw : 'unknown'
  ) as LpIncreaseCommand['status'];

  return {
    id,
    status,
    requestedAt: typeof r.requestedAt === 'string' ? r.requestedAt : null,
    txHash: typeof r.txHash === 'string' && r.txHash.trim() !== '' ? r.txHash : null,
    error: typeof r.error === 'string' && r.error.trim() !== '' ? r.error : null,
  };
}

export { DEFAULT_SWAP_SLIPPAGE, MAX_SWAP_SLIPPAGE };
