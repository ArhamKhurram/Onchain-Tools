// Pre-trade gates. These are EXECUTION CORRECTNESS, not policy.
//
// The distinction matters for where they live. The caps and the kill switch are
// policy: the operator decides how much risk to take, and executeFire enforces
// it. These two are different — they answer "is this trade a trade at all?", and
// the answer does not depend on anybody's risk appetite:
//
//   * A pool with $32 behind a $45,000 "market cap" is not a thin trade, it is
//     an unfillable one. (That is a real token observed on this chain, not a
//     hypothetical.)
//   * A token that cannot be sold is not a position, it is a donation.
//
// Both gates therefore sit inside the executor, in front of signing, and both
// DEFAULT ON. `SNIPER_EVM_LIQUIDITY_GATE` and `SNIPER_EVM_SELL_SIM_GATE` exist
// so an operator can turn one off deliberately, and turning one off is loud.
//
// Everything here runs on `eth_call`/`eth_simulateV1` and needs NO PRIVATE KEY.
// The simulated buyer is an arbitrary address handed a synthetic balance by a
// state override. That is what lets the full gate path be exercised — in tests,
// in dry runs, and by an operator who has not funded a wallet yet.

import type { EvmSniperConfig } from './config.js';
import type { EvmRpc, SimCall, SimStateOverride } from './rpc.js';
import type { Route } from './routing.js';
import { buildBuyTx, buildSellApprovals, buildSellTx, encodeBalanceOf } from './swap.js';

/**
 * The address every simulation runs as.
 *
 * Deliberately NOT the operator's wallet. A simulation from the real wallet
 * would silently depend on that wallet's balances, allowances and any
 * per-address behaviour a hostile token implements — so a token that whitelists
 * one address would pass a gate it should fail, and the gate's verdict would
 * stop being a property of the token. A fixed, empty, key-less address given a
 * synthetic balance keeps the answer about the token and the pool.
 */
// All-lowercase on purpose: viem validates EIP-55 casing on any mixed-case
// address, and an address nobody controls has no reason to carry a checksum.
export const SIMULATION_SENDER = '0x00000000000000000000000000000000000051a1' as const;

/** Why a buy was refused before any money moved. Rendered to the operator verbatim. */
export type GateRejection =
  | 'thin_liquidity'
  | 'buy_reverts'
  | 'buy_returns_nothing'
  | 'sell_reverts'
  | 'gate_rpc_failed';

export type GateResult =
  | {
      ok: true;
      /**
       * Tokens the simulated buy produced. The real transaction's
       * `amountOutMinimum` is derived from this, so the slippage floor is
       * anchored to a measured quote rather than to zero.
       */
      expectedOut: bigint;
      /** Which gates actually ran. An operator-disabled gate is reported, not hidden. */
      ran: { liquidity: boolean; sellSim: boolean };
    }
  | { ok: false; reason: GateRejection; detail: string };

export interface GateParams {
  rpc: EvmRpc;
  route: Route;
  token: string;
  /** Native wei about to be spent. */
  amountInWei: bigint;
  deadline: bigint;
  config: Pick<
    EvmSniperConfig,
    'minLiquidityUsd' | 'minRoundTripBps' | 'liquidityGateEnabled' | 'sellSimGateEnabled'
  >;
}

/** `0x1` is success in the `eth_simulateV1` per-call result. Anything else reverted. */
function failed(status: string | undefined): boolean {
  return status !== '0x1';
}

function firstError(results: { status: string; error?: { message: string } }[]): string {
  const bad = results.findIndex((r) => failed(r.status));
  if (bad < 0) return 'unknown';
  return `call ${bad}: ${results[bad].error?.message ?? 'reverted'}`;
}

/**
 * Run both gates. Returns the measured quote on success so the caller does not
 * have to re-derive it.
 *
 * ANY RPC failure is a rejection, never a pass. A gate that cannot reach the
 * chain has not verified anything, and "we could not check" must not read the
 * same as "we checked and it is fine" — that is the one way a gate becomes
 * decorative.
 */
export async function runPreTradeGates(p: GateParams): Promise<GateResult> {
  const { rpc, route, token, amountInWei, deadline, config } = p;

  // ---- Gate 1: liquidity floor ------------------------------------------
  //
  // Checked against the pool we are actually routing to, not against the
  // token's total liquidity across pools. Summing pools would pass a token
  // whose depth is all in a USDG pair we cannot reach, and then route the buy
  // into the $32 one anyway.
  if (config.liquidityGateEnabled && route.liquidityUsd < config.minLiquidityUsd) {
    return {
      ok: false,
      reason: 'thin_liquidity',
      detail: `pool has $${Math.round(route.liquidityUsd)} < $${Math.round(config.minLiquidityUsd)} floor`,
    };
  }

  // Both remaining checks need the simulated buy, so build it once.
  const buy = buildBuyTx({
    route,
    token,
    amountIn: amountInWei,
    // The probe deliberately enforces NO floor: its job is to discover what the
    // pool returns, and a floor here would turn "the quote is X" into "the
    // quote is at least Y", which is a different question and a worse one.
    amountOutMinimum: 0n,
    deadline,
    recipient: SIMULATION_SENDER,
  });

  // Enough native ETH to cover the buy plus gas, with room to spare. Granted by
  // state override, so no wallet is funded and no key exists.
  const overrides: Record<string, SimStateOverride> = {
    [SIMULATION_SENDER]: { balance: `0x${(amountInWei * 4n + 10n ** 18n).toString(16)}` },
  };

  const asSim = (tx: { to: string; data: string; value?: bigint }): SimCall => ({
    from: SIMULATION_SENDER,
    to: tx.to,
    data: tx.data,
    value: tx.value !== undefined ? `0x${tx.value.toString(16)}` : undefined,
  });

  // ---- Probe: does the buy work, and what does it return? ----------------
  let probe;
  try {
    probe = await rpc.simulate([asSim(buy), { from: SIMULATION_SENDER, to: token, data: encodeBalanceOf(SIMULATION_SENDER) }], overrides);
  } catch (err) {
    return { ok: false, reason: 'gate_rpc_failed', detail: (err as Error)?.message ?? 'rpc error' };
  }
  if (probe.length < 2) {
    return { ok: false, reason: 'gate_rpc_failed', detail: 'simulation returned no results' };
  }
  if (failed(probe[0].status)) {
    // The buy itself reverts. Worth its own reason: a hostile token, a paused
    // pool and a bad route all land here, and none of them are "thin".
    return { ok: false, reason: 'buy_reverts', detail: probe[0].error?.message ?? 'buy reverted in simulation' };
  }

  const expectedOut = probe[1].returnData && probe[1].returnData !== '0x' ? BigInt(probe[1].returnData) : 0n;
  if (expectedOut === 0n) {
    // A buy that "succeeds" and delivers nothing is the classic fee-on-transfer
    // trap: the transaction lands, the balance does not move.
    return { ok: false, reason: 'buy_returns_nothing', detail: 'simulated buy produced 0 tokens' };
  }

  if (!config.sellSimGateEnabled) {
    return { ok: true, expectedOut, ran: { liquidity: config.liquidityGateEnabled, sellSim: false } };
  }

  // ---- Gate 2: sell simulation ------------------------------------------
  //
  // The exit is simulated as the round trip an operator would actually have to
  // perform: buy, approve, sell back to native — in ONE eth_simulateV1 block, so
  // the sell spends the exact tokens the buy produced. That is why this needs no
  // storage-slot forgery to fake a token balance: the balance is real, because
  // the buy that created it is real within the simulation.
  //
  // The floor is enforced BY the swap rather than measured after it: the sell's
  // `amountOutMinimum` is set to the required round-trip amount, so a token that
  // cannot return it reverts. That works identically for V3 (which returns the
  // amount) and V4 (whose `execute` returns nothing), instead of one path
  // decoding return data and the other trusting it.
  const requiredBack = (amountInWei * BigInt(config.minRoundTripBps)) / 10_000n;
  const sell = buildSellTx({
    route,
    token,
    amountIn: expectedOut,
    amountOutMinimum: requiredBack,
    deadline,
    recipient: SIMULATION_SENDER,
  });

  const sequence: SimCall[] = [
    asSim(buy),
    ...buildSellApprovals(route, token).map((c) => ({ from: SIMULATION_SENDER, to: c.to, data: c.data })),
    asSim(sell),
  ];

  let roundTrip;
  try {
    roundTrip = await rpc.simulate(sequence, overrides);
  } catch (err) {
    return { ok: false, reason: 'gate_rpc_failed', detail: (err as Error)?.message ?? 'rpc error' };
  }
  if (roundTrip.length !== sequence.length || roundTrip.some((r) => failed(r.status))) {
    return {
      ok: false,
      reason: 'sell_reverts',
      detail: `round trip failed at ${firstError(roundTrip)} (needed ${config.minRoundTripBps}bps back)`,
    };
  }

  return { ok: true, expectedOut, ran: { liquidity: config.liquidityGateEnabled, sellSim: true } };
}
