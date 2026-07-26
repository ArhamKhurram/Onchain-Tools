// Robinhood Chain as a viem chain config.
//
// The chain id comes from `src/types.ts` (verified against Krystal's live
// routing table — see LP_AUTOMATION_PLAN.md §1), never re-typed as a literal.
//
// RPC endpoints are *always* supplied by the caller from env. This module never
// embeds a URL: the plan's providers (Alchemy, QuickNode — §3) issue per-account
// URLs with the API key in the path, so a hardcoded default would either be a
// leaked key or a public endpoint quietly standing in for the paid one.
//
// Cross-check: viem >= 2.5x ships its own `robinhood` chain definition whose id
// (4663), native currency (ETH) and multicall3 address match the values below.
// We define our own anyway so the RPC URL is unambiguously ours and no code
// path can fall back to a bundled public endpoint.

import { defineChain, type Chain } from 'viem';
import { ROBINHOOD_CHAIN_ID } from '../../types.js';

/**
 * Robinhood Chain's advertised block time, in milliseconds.
 *
 * UNVERIFIED against a live node — taken from viem's bundled chain metadata.
 * It is used only to derive *defaults* (staleness threshold, confirmation
 * depth), never for correctness, so a wrong value degrades tuning rather than
 * behaviour. Worth confirming against the chain before tightening any of them.
 */
export const ROBINHOOD_BLOCK_TIME_MS = 100;

/** Canonical multicall3 deployment; lets viem batch slot0 reads across pools. */
const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11' as const;

export interface RobinhoodChainParams {
  /** HTTPS JSON-RPC endpoint. Required — used for eth_call and as poll fallback. */
  httpUrl: string;
  /** WSS endpoint for eth_subscribe. Optional; absent means polling-only. */
  wsUrl?: string | null;
}

/** Builds the viem `Chain` for Robinhood Chain against caller-supplied endpoints. */
export function defineRobinhoodChain({ httpUrl, wsUrl }: RobinhoodChainParams): Chain {
  if (!httpUrl) throw new Error('defineRobinhoodChain: httpUrl is required');

  return defineChain({
    id: ROBINHOOD_CHAIN_ID,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockTime: ROBINHOOD_BLOCK_TIME_MS,
    rpcUrls: {
      default: {
        http: [httpUrl],
        ...(wsUrl ? { webSocket: [wsUrl] } : {}),
      },
    },
    blockExplorers: {
      default: {
        name: 'Blockscout',
        url: 'https://robinhoodchain.blockscout.com',
        apiUrl: 'https://robinhoodchain.blockscout.com/api',
      },
    },
    contracts: {
      multicall3: { address: MULTICALL3_ADDRESS },
    },
  });
}
