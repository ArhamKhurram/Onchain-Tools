// ERC-20 approve transactions built locally (not via Krystal).
//
// Zap-in and zap-increase pull tokens from the Safe via transferFrom, which
// requires a prior approve on the token contract. The worker checks allowance
// before those actions and broadcasts approve when needed — so the operator
// never has to touch the Safe UI for each deposit.
//
// The on-chain module must allowlist each token + the approve selector (0x095ea7b3).
// See scripts/lib/constants.ts `ROBINHOOD_ALLOWLIST` and seedAllowlist.ts.

import { encodeFunctionData } from 'viem';
import type { Address } from '../types.js';
import { KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3 } from './validate.js';
import type { PreparedTransaction, PreparedTransactionMeta } from './types.js';

/** IERC20.approve(address,uint256) */
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3' as const;

/** Unlimited approval — standard DeFi pattern; one approve per token+spender. */
export const MAX_UINT256 = (1n << 256n) - 1n;

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Krystal v3utils — the only spender we approve for zap flows today. */
export const KRYSTAL_V3UTILS = KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.v3utils;

/** WETH on Robinhood Chain — the zap input token we auto-approve today. */
export const ROBINHOOD_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address;

/** Tokens the worker may broadcast `approve` for (must match module allowlist). */
export const DEFAULT_APPROVABLE_TOKENS: readonly Address[] = [ROBINHOOD_WETH];

export interface Erc20ReadClient {
  readContract(request: {
    address: Address;
    abi: typeof ERC20_ABI;
    functionName: 'allowance';
    args: readonly [Address, Address];
  }): Promise<bigint>;
}

export interface BuildApproveContext {
  chainId: number;
  safe: Address;
  builtAt: number;
}

/**
 * Tokens the module may call `approve` on. Extend when new zap input tokens are
 * added to the on-chain allowlist (one owner-signed tx per token).
 */
export function isApprovableToken(token: Address, allowedTokens: readonly Address[]): boolean {
  const lower = token.toLowerCase();
  return allowedTokens.some((entry) => entry.toLowerCase() === lower);
}

export async function readErc20Allowance(
  client: Erc20ReadClient,
  owner: Address,
  token: Address,
  spender: Address = KRYSTAL_V3UTILS,
): Promise<bigint> {
  const value = await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function buildErc20Approve(
  context: BuildApproveContext,
  token: Address,
  spender: Address,
  amount: bigint = MAX_UINT256,
): PreparedTransaction {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  }) as `0x${string}`;

  const meta: PreparedTransactionMeta = {
    kind: 'erc20_approve',
    chainId: context.chainId,
    platform: 'local',
    from: context.safe,
    selector: ERC20_APPROVE_SELECTOR,
    estimateGas: null,
    gasLimit: null,
    usedDefaultGas: false,
    builtAt: context.builtAt,
    txInfo: { token, spender, amount: amount.toString() },
  };

  return {
    to: token,
    value: 0n,
    data,
    meta,
  };
}
