import type { Address, LpPosition, TokenRef } from '../types.js';

export interface DecreaseLiquidityParams {
  liquidityPercent?: number | null;
  amountOut?: string | null;
}

export type ResolveDecreaseLiquidityResult =
  | { ok: true; liquidityPercent: number; estimatedWithdrawUsd: number | null }
  | { ok: false; reason: string };

function poolToken(position: LpPosition, address: Address): TokenRef | null {
  if (position.pool.token0.address === address) return position.pool.token0;
  if (position.pool.token1.address === address) return position.pool.token1;
  return null;
}

function amountOutUsdEstimate(
  amountOut: string,
  token: TokenRef,
  nativeTokenUsd: number | null,
): number | null {
  try {
    const wei = BigInt(amountOut);
    if (wei <= 0n) return null;
    const units = Number(wei) / 10 ** token.decimals;
    if (!Number.isFinite(units) || units <= 0) return null;
    const symbol = token.symbol?.toUpperCase() ?? '';
    if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'USDT0' || symbol === 'USD') return units;
    if (nativeTokenUsd !== null && Number.isFinite(nativeTokenUsd) && nativeTokenUsd > 0 && token.decimals === 18) {
      return units * nativeTokenUsd;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveDecreaseLiquidityPercent(
  params: DecreaseLiquidityParams,
  position: LpPosition,
  tokenOutAddress: Address,
  nativeTokenUsd: number | null = null,
): ResolveDecreaseLiquidityResult {
  const hasPercent = params.liquidityPercent !== null && params.liquidityPercent !== undefined;
  const amountOut =
    typeof params.amountOut === 'string' && params.amountOut.trim() !== '' ? params.amountOut : null;
  const hasAmount = amountOut !== null;
  if (hasPercent && hasAmount) return { ok: false, reason: 'provide liquidityPercent or amountOut, not both' };
  if (!hasPercent && !hasAmount) return { ok: false, reason: 'liquidityPercent or amountOut is required' };
  if (hasPercent) {
    const liquidityPercent = params.liquidityPercent!;
    if (!Number.isFinite(liquidityPercent) || liquidityPercent <= 0 || liquidityPercent > 1) {
      return { ok: false, reason: 'liquidityPercent must be a fraction in (0, 1]' };
    }
    const estimatedWithdrawUsd =
      Number.isFinite(position.valueUsd) && position.valueUsd > 0 ? position.valueUsd * liquidityPercent : null;
    return { ok: true, liquidityPercent, estimatedWithdrawUsd };
  }
  const token = poolToken(position, tokenOutAddress);
  if (token === null) return { ok: false, reason: `token ${tokenOutAddress} is not in pool ${position.pool.address}` };
  const amountOutUsd = amountOutUsdEstimate(amountOut!, token, nativeTokenUsd);
  if (amountOutUsd === null || amountOutUsd <= 0) {
    return { ok: false, reason: 'could not estimate USD value for amountOut' };
  }
  const positionValue = position.valueUsd;
  if (!Number.isFinite(positionValue) || positionValue <= 0) {
    return { ok: false, reason: 'position has no indicative USD value for amount-based decrease' };
  }
  const liquidityPercent = Math.min(1, amountOutUsd / positionValue);
  if (liquidityPercent <= 0) return { ok: false, reason: 'amountOut is too small relative to the position value' };
  return { ok: true, liquidityPercent, estimatedWithdrawUsd: amountOutUsd };
}
