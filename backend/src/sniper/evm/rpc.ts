// The narrow JSON-RPC surface the EVM sniper actually needs.
//
// Deliberately NOT a viem client type. Three reasons, in order of importance:
//
//  1. `eth_simulateV1` — the whole basis of the sell-simulation gate — is not in
//     viem's typed method map on this version, so it would be a cast either way.
//  2. The gates are the part of this module that most needs unit tests, and a
//     three-method interface can be stubbed with an object literal. Mocking a
//     viem client means mocking a transport, which tests the mock.
//  3. It keeps the read path (gates, routing) free of any dependency on the
//     write path (viem accounts, signing) — so every gate runs, in full, with no
//     private key present. That is what makes "buildable, testable and
//     dry-runnable with no key" true rather than aspirational.
//
// `makeHttpEvmRpc` below is the one implementation that touches the network.

/** A single simulated call. `from` may be any address — simulation needs no key and no signature. */
export interface SimCall {
  from: string;
  to: string;
  /** Hex-quantity wei, e.g. '0x2386f26fc10000'. */
  value?: string;
  data: string;
}

/** Per-address state overrides. Only the fields this module uses are modelled. */
export interface SimStateOverride {
  /** Hex-quantity wei. Used to hand the simulated sender enough ETH to make the buy. */
  balance?: string;
}

export interface SimCallResult {
  /** '0x1' on success, '0x0' on revert. */
  status: string;
  returnData: string;
  error?: { code: number; message: string };
}

/**
 * The three RPC verbs this module needs.
 *
 * Every method REJECTS on transport failure rather than returning a sentinel.
 * That matters: the gates treat a thrown error as "gate not satisfied" and
 * abort the buy, so an RPC outage stops the sniper instead of blinding it.
 * A method that swallowed errors into `null` would make "the node is down" and
 * "the pool is fine" indistinguishable at the call site.
 */
export interface EvmRpc {
  /** eth_call at latest. */
  call(to: string, data: string): Promise<string>;
  /** eth_getLogs. Used only for V4 PoolKey recovery, which is a single indexed match. */
  getLogs(params: { address: string; topics: (string | null)[]; fromBlock: string; toBlock: string }): Promise<
    { data: string; topics: string[] }[]
  >;
  /**
   * eth_simulateV1: a sequence of calls executed against one block, with state
   * carried forward BETWEEN them. That carry-forward is the entire reason this
   * gate can exist — it is what lets a simulated sell spend the tokens a
   * simulated buy just produced, with no storage-slot archaeology and no key.
   */
  simulate(calls: SimCall[], overrides?: Record<string, SimStateOverride>): Promise<SimCallResult[]>;
}

/** Thrown for any non-2xx / JSON-RPC-error response, so callers see one error type. */
export class EvmRpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = 'EvmRpcError';
  }
}

/**
 * Longer than a typical HTTP timeout for the same reason
 * `SLOTSHARK_TIMEOUT_MS` is: these calls gate a spend, and a premature timeout
 * reads as "gate failed" and cancels a fire. Short enough that a hung node does
 * not hold the fire window open to no purpose.
 */
const RPC_TIMEOUT_MS = 12_000;

export function makeHttpEvmRpc(rpcUrl: string): EvmRpc {
  let nextId = 1;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EvmRpcError(`transport failure: ${(err as Error)?.message ?? err}`, method);
    }
    if (!res.ok) throw new EvmRpcError(`HTTP ${res.status}`, method);

    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new EvmRpcError(body.error.message ?? 'rpc error', method);
    if (body.result === undefined) throw new EvmRpcError('empty result', method);
    return body.result;
  }

  return {
    call: (to, data) => rpc<string>('eth_call', [{ to, data }, 'latest']),

    getLogs: (params) =>
      rpc<{ data: string; topics: string[] }[]>('eth_getLogs', [
        { address: params.address, topics: params.topics, fromBlock: params.fromBlock, toBlock: params.toBlock },
      ]),

    async simulate(calls, overrides) {
      const blocks = await rpc<{ calls: SimCallResult[] }[]>('eth_simulateV1', [
        {
          blockStateCalls: [{ stateOverrides: overrides ?? {}, calls }],
          // `validation: false` skips nonce/balance/signature checks, which is
          // what allows simulating from an address that holds nothing and is not
          // ours. `traceTransfers` is off because the gate reads return data,
          // not transfer logs, and the log stream on a hooked pool is large.
          validation: false,
          traceTransfers: false,
        },
        'latest',
      ]);
      // One entry per blockStateCall; we always send exactly one.
      return blocks[0]?.calls ?? [];
    },
  };
}
