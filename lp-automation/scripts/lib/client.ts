// viem client construction, plus the chain-id assertion every script runs.
//
// The assertion is not a formality and is not cached across a script's lifetime:
// `assertChainId` is called once at startup AND again immediately before any
// broadcast, because minutes can pass at a confirmation prompt and an RPC URL
// can be a load balancer in front of more than one network.

import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem';
import type { PrivateKeyAccount } from 'viem';
import { defineRobinhoodChain } from '../../src/ingest/rpc/chain.js';
import { ArgError, checkChainId, checkRpcUrl } from './args.js';

export interface ClientBundle {
  readonly publicClient: PublicClient;
  readonly rpcUrl: string;
  readonly rpcWarnings: readonly string[];
}

/** Build a read-only client. Never holds a key. */
export function buildPublicClient(rpcUrlRaw: string | undefined): ClientBundle {
  const { url, warnings } = checkRpcUrl(rpcUrlRaw);
  const chain = defineRobinhoodChain({ httpUrl: url });
  const publicClient = createPublicClient({
    chain,
    transport: http(url, { retryCount: 2, timeout: 20_000 }),
  }) as PublicClient;
  return { publicClient, rpcUrl: url, rpcWarnings: warnings };
}

/**
 * Build a signing client. The account was derived in `env.ts`; no key is passed
 * here. The return type is deliberately inferred rather than widened to
 * `WalletClient`, so viem keeps the account/chain binding and `deployContract`
 * stays type-safe.
 */
export function buildWalletClient(rpcUrl: string, account: PrivateKeyAccount) {
  const chain = defineRobinhoodChain({ httpUrl: rpcUrl });
  return createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 2, timeout: 20_000 }) });
}

/**
 * Ask the RPC what chain it is on and refuse to continue if it is the wrong one.
 *
 * Deploying to the wrong chain is the classic silent, expensive mistake: the
 * transaction succeeds, the address looks plausible, and nothing tells you until
 * the Safe you meant to bind to does not exist. Every write path in this tooling
 * calls this immediately before sending.
 */
export async function assertChainId(
  publicClient: PublicClient,
  allowChainId?: number | undefined,
): Promise<{ chainId: number; note?: string }> {
  let chainId: number;
  try {
    chainId = await publicClient.getChainId();
  } catch (err) {
    throw new ArgError(
      `Could not reach the RPC to read its chain id: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const verdict = checkChainId(chainId, allowChainId);
  if (!verdict.ok) throw new ArgError(verdict.reason ?? `Wrong chain id: ${chainId}`);
  return verdict.reason === undefined ? { chainId } : { chainId, note: verdict.reason };
}

/** True when an address has deployed bytecode. Used for every "does this exist" check. */
export async function hasCode(publicClient: PublicClient, address: `0x${string}`): Promise<number> {
  const code = await publicClient.getCode({ address });
  if (code === undefined || code === '0x') return 0;
  return (code.length - 2) / 2;
}
