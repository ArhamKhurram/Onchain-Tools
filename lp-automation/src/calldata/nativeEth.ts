// Native ETH vs WETH for Krystal zap flows (swap_and_mint / swap_and_increase).
//
// Krystal accepts the industry-standard native-token sentinel as `tokenIn` and
// returns a non-zero `txData.value` equal to `amountIn`. WETH is an ERC-20 zap:
// `value` stays zero and the Safe must hold an allowance instead.

import { ROBINHOOD_WETH } from './erc20Approve.js';
import type { Address } from '../types.js';

/** Krystal / DeFi convention for "pay with native ETH". */
export const NATIVE_ETH_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;

export function isNativeEthAddress(address: string): boolean {
  return address.toLowerCase() === NATIVE_ETH_ADDRESS;
}

export function poolHasWethSide(
  token0: Address,
  token1: Address,
  weth: Address = ROBINHOOD_WETH,
): boolean {
  const needle = weth.toLowerCase();
  return token0.toLowerCase() === needle || token1.toLowerCase() === needle;
}

export type ResolveZapTokenInResult =
  | {
      ok: true;
      poolTokenAddress: Address;
      krystalTokenIn: Address;
      isNative: boolean;
    }
  | { ok: false; reason: string };

export function resolveZapTokenIn(params: {
  tokenInAddress: Address;
  poolToken0: Address;
  poolToken1: Address;
  weth?: Address;
}): ResolveZapTokenInResult {
  const token0 = params.poolToken0.toLowerCase() as Address;
  const token1 = params.poolToken1.toLowerCase() as Address;
  const tokenIn = params.tokenInAddress.toLowerCase() as Address;
  const weth = (params.weth ?? ROBINHOOD_WETH).toLowerCase() as Address;

  if (isNativeEthAddress(tokenIn)) {
    if (!poolHasWethSide(token0, token1, weth)) {
      return {
        ok: false,
        reason:
          `native ETH zap requires a WETH pool side (${token0} / ${token1}); ` +
          'refusing to enter with an unknown swap path.',
      };
    }
    const poolToken = token0 === weth ? token0 : token1;
    return { ok: true, poolTokenAddress: poolToken, krystalTokenIn: NATIVE_ETH_ADDRESS, isNative: true };
  }

  if (tokenIn === token0 || tokenIn === token1) {
    return { ok: true, poolTokenAddress: tokenIn, krystalTokenIn: tokenIn, isNative: false };
  }

  return {
    ok: false,
    reason: `token ${tokenIn} is not in pool (${token0} / ${token1})`,
  };
}
