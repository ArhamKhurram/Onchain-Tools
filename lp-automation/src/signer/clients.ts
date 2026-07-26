// The narrow client seam the signer talks to, plus the viem factory that builds
// the real thing.
//
// Same reasoning as `calldata/dryRun.ts`: the signer is typed against the
// smallest possible surface rather than viem's `PublicClient`/`WalletClient`.
// That buys three things —
//
//   1. Tests can substitute a plain object. No network, no fixtures, no
//      pretending a mocked HTTP transport is a chain.
//   2. The read path is structurally incapable of sending: `SignerPublicClient`
//      exposes no `writeContract`/`sendTransaction`, so a misplaced `await` in
//      the preflight ladder cannot broadcast.
//   3. Reads come back as `unknown`. That is not laziness — viem's inference
//      would let a malformed RPC response be typed as `boolean` and sail through
//      a truthiness check. Forcing an explicit runtime shape check at every read
//      is what makes "cannot evaluate => reject" enforceable (plan §4).
//
// The key never appears in this module's exported types. `createModuleClients`
// takes it as an argument, derives the address, and lets it fall out of scope;
// the only thing that retains it is the closure inside viem's account object,
// which has no enumerable property holding it.

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { defineRobinhoodChain } from '../ingest/rpc/chain.js';
import type { Address } from '../types.js';

export interface ContractReadRequest {
  readonly address: `0x${string}`;
  readonly abi: readonly unknown[];
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

export interface ContractSimulateRequest extends ContractReadRequest {
  /** The address the call is simulated FROM. Always the operator, never the Safe. */
  readonly account: `0x${string}`;
}

/** Read + simulate only. Cannot broadcast; that is the point of the split. */
export interface SignerPublicClient {
  readContract(request: ContractReadRequest): Promise<unknown>;
  simulateContract(request: ContractSimulateRequest): Promise<{ request: unknown }>;
}

/**
 * The only broadcast-capable surface in the system.
 *
 * `writeContract` takes the *simulated* request verbatim. Rebuilding the
 * transaction between simulation and send would mean broadcasting something
 * that was never simulated.
 */
export interface SignerWalletClient {
  writeContract(request: unknown): Promise<`0x${string}`>;
}

export interface ModuleClients {
  readonly publicClient: SignerPublicClient;
  readonly walletClient: SignerWalletClient;
  /** Derived once, from the key, at construction. The key itself is not retained. */
  readonly operatorAddress: Address;
}

export interface CreateModuleClientsParams {
  readonly rpcUrl: string;
  readonly privateKey: `0x${string}`;
}

/**
 * Decide what viem should be handed as the `account` for a simulation.
 *
 * This looks like plumbing and is not. viem branches on the TYPE of `account`:
 * a local account object signs in-process and sends `eth_sendRawTransaction`;
 * a bare address string becomes a `json-rpc` account and sends
 * `eth_sendTransaction`, i.e. it asks the RPC PROVIDER to sign. Our provider
 * holds no key, so that path cannot work — but the difference only surfaces at
 * broadcast time, long after the simulation said everything was fine.
 *
 * Since `simulateContract` returns the account inside its request and
 * `writeContract` sends that request verbatim, the substitution has to happen
 * here, on the way in.
 *
 * If the requested address is NOT the local account's, the address is passed
 * through unchanged. The simulation still runs (it is only an `eth_call` from
 * that address), and the subsequent send fails loudly instead of quietly
 * signing as somebody the caller did not ask for.
 */
export function resolveSimulationAccount<TAccount extends { address: string }>(
  requested: `0x${string}`,
  local: TAccount,
): TAccount | `0x${string}` {
  return requested.toLowerCase() === local.address.toLowerCase() ? local : requested;
}

/**
 * Build the real viem clients.
 *
 * This is the ONLY function in the workspace that takes a private key. It is
 * deliberately tiny and dependency-light so that "what touches the key" is a
 * question with a one-screen answer.
 */
export function createModuleClients({ rpcUrl, privateKey }: CreateModuleClientsParams): ModuleClients {
  const chain = defineRobinhoodChain({ httpUrl: rpcUrl });

  // Derived once. After this line the raw key exists only inside the signing
  // closures viem built; nothing in this process holds it in a named field.
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // The adapters below are the single place where viem's heavily-generic
  // signatures meet our narrow ones. The casts are confined here on purpose.
  const reads: SignerPublicClient = {
    readContract: (request) =>
      publicClient.readContract(request as Parameters<typeof publicClient.readContract>[0]) as Promise<unknown>,
    simulateContract: (request) =>
      publicClient.simulateContract({
        ...request,
        // See `resolveSimulationAccount`: this is what makes the eventual
        // broadcast sign locally instead of asking the RPC provider to sign.
        account: resolveSimulationAccount(request.account, account),
      } as unknown as Parameters<typeof publicClient.simulateContract>[0]) as unknown as Promise<{
        request: unknown;
      }>,
  };

  const writes: SignerWalletClient = {
    writeContract: (request) =>
      walletClient.writeContract(request as Parameters<typeof walletClient.writeContract>[0]),
  };

  return {
    publicClient: reads,
    walletClient: writes,
    operatorAddress: account.address.toLowerCase() as Address,
  };
}
