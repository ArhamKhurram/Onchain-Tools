import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPreTradeGates, SIMULATION_SENDER } from '../src/sniper/evm/gates';
import type { EvmRpc, SimCall, SimCallResult, SimStateOverride } from '../src/sniper/evm/rpc';
import type { Route } from '../src/sniper/evm/routing';

const TOKEN = '0x79fe86b963255ce884bdcac6388c50a599ba277f';
const AMOUNT = 10_000_000_000_000_000n; // 0.01 ETH
const DEADLINE = 1_785_000_120n;

const v3Route: Route = {
  family: 'uniswap_v3',
  poolAddress: '0x8aac0c4c9236096aa79262b0a53a683979ed8c7a',
  fee: 10_000,
  liquidityUsd: 30_000,
};
const v4Route: Route = {
  family: 'uniswap_v4',
  poolId: '0x' + '4'.repeat(64),
  poolKey: {
    currency0: '0x' + '0'.repeat(40),
    currency1: TOKEN,
    fee: 0,
    tickSpacing: 200,
    hooks: '0x' + 'e'.repeat(40),
  },
  zeroForOne: true,
  liquidityUsd: 30_000,
};

const cfg = {
  minLiquidityUsd: 5_000,
  minRoundTripBps: 5_000,
  liquidityGateEnabled: true,
  sellSimGateEnabled: true,
};

const ok = (returnData = '0x'): SimCallResult => ({ status: '0x1', returnData });
const reverted = (message = 'execution reverted'): SimCallResult => ({
  status: '0x0',
  returnData: '0x',
  error: { code: 3, message },
});
/** A non-zero uint256 balanceOf result. */
const tokensOut = (n: bigint): SimCallResult => ok('0x' + n.toString(16).padStart(64, '0'));

interface Recorded {
  calls: SimCall[];
  overrides?: Record<string, SimStateOverride>;
}

/**
 * A scripted `eth_simulateV1`. `scripts` is consumed one entry per simulate()
 * call — the gate makes at most two (the buy probe, then the round trip).
 */
function scriptedRpc(scripts: SimCallResult[][], seen: Recorded[] = []): EvmRpc {
  let i = 0;
  return {
    call: async () => { throw new Error('call not stubbed'); },
    getLogs: async () => { throw new Error('getLogs not stubbed'); },
    simulate: async (calls, overrides) => {
      seen.push({ calls, overrides });
      const next = scripts[i++];
      if (!next) throw new Error(`unexpected simulate() call #${i}`);
      return next;
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('gate 1 — the liquidity floor', () => {
  it('rejects a pool below the floor, before any RPC call', async () => {
    // The $32-behind-a-$45k-market-cap case. The rpc stub throws on every
    // method, so a passing test also proves nothing was queried.
    const rpc = scriptedRpc([]);
    const r = await runPreTradeGates({
      rpc,
      route: { ...v3Route, liquidityUsd: 32 },
      token: TOKEN,
      amountInWei: AMOUNT,
      deadline: DEADLINE,
      config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'thin_liquidity' });
    expect(r.ok === false && r.detail).toContain('$32');
  });

  it('rejects a pool exactly at the floor minus a dollar, accepts at the floor', async () => {
    const below = await runPreTradeGates({
      rpc: scriptedRpc([]),
      route: { ...v3Route, liquidityUsd: 4_999 },
      token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(below).toMatchObject({ ok: false, reason: 'thin_liquidity' });

    const at = await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(123n)], [ok(), ok(), ok()]]),
      route: { ...v3Route, liquidityUsd: 5_000 },
      token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(at.ok).toBe(true);
  });

  it('can be turned off deliberately, and says so in `ran`', async () => {
    const r = await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(9n)], [ok(), ok(), ok()]]),
      route: { ...v3Route, liquidityUsd: 1 },
      token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE,
      config: { ...cfg, liquidityGateEnabled: false },
    });
    expect(r).toMatchObject({ ok: true, ran: { liquidity: false, sellSim: true } });
  });
});

describe('gate 2 — the sell simulation', () => {
  it('aborts the buy when the simulated sell REVERTS', async () => {
    // buy probe succeeds; the round trip reverts at the sell.
    const r = await runPreTradeGates({
      rpc: scriptedRpc([
        [ok(), tokensOut(1_000n)],
        [ok(), ok(), reverted('execution reverted: Too little received')],
      ]),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'sell_reverts' });
    expect(r.ok === false && r.detail).toContain('Too little received');
  });

  it('aborts when the sell would return under the round-trip floor', async () => {
    // The floor is enforced BY the swap: the sell carries amountOutMinimum, so
    // "returns ~0" and "reverts" are the same observable, which is the point.
    const r = await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(1_000n)], [ok(), ok(), reverted()]]),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'sell_reverts' });
  });

  it('aborts when an APPROVAL in the exit path reverts — a blocked approve is an unsellable token', async () => {
    const r = await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(1_000n)], [ok(), reverted('approve blocked'), ok()]]),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'sell_reverts' });
    expect(r.ok === false && r.detail).toContain('call 1');
  });

  it('aborts when the BUY itself reverts, with its own distinct reason', async () => {
    const r = await runPreTradeGates({
      rpc: scriptedRpc([[reverted('Transaction too old'), ok()]]),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'buy_reverts' });
  });

  it('aborts when a "successful" buy delivers zero tokens (fee-on-transfer trap)', async () => {
    const r = await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(0n)]]),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'buy_returns_nothing' });
  });

  it('passes a healthy round trip and returns the measured quote', async () => {
    const r = await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(317872554707791195593749n)], [ok(), ok(), ok()]]),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: true, expectedOut: 317872554707791195593749n });
  });

  it('can be turned off deliberately, and then only the buy probe runs', async () => {
    const r = await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(5n)]]),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE,
      config: { ...cfg, sellSimGateEnabled: false },
    });
    expect(r).toMatchObject({ ok: true, ran: { liquidity: true, sellSim: false } });
  });

  it('runs three calls for a V3 exit and four for a V4 exit (Permit2 needs two approvals)', async () => {
    const seenV3: Recorded[] = [];
    await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(1n)], [ok(), ok(), ok()]], seenV3),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(seenV3[1].calls).toHaveLength(3); // buy, approve(router), sell

    const seenV4: Recorded[] = [];
    await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(1n)], [ok(), ok(), ok(), ok()]], seenV4),
      route: v4Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(seenV4[1].calls).toHaveLength(4); // buy, approve(Permit2), Permit2.approve, sell
  });
});

describe('the gates need no private key and no funded wallet', () => {
  it('simulates as a fixed key-less address funded by a state override', async () => {
    const seen: Recorded[] = [];
    await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(1n)], [ok(), ok(), ok()]], seen),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    // Every call is from the synthetic sender, never from an operator wallet —
    // so the verdict is a property of the token, not of who is asking.
    expect(seen[0].calls.every((c) => c.from === SIMULATION_SENDER)).toBe(true);
    const balance = seen[0].overrides?.[SIMULATION_SENDER]?.balance;
    expect(balance).toBeDefined();
    expect(BigInt(balance!)).toBeGreaterThan(AMOUNT);
  });

  it('sends the buy with the full native value attached', async () => {
    const seen: Recorded[] = [];
    await runPreTradeGates({
      rpc: scriptedRpc([[ok(), tokensOut(1n)], [ok(), ok(), ok()]], seen),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(BigInt(seen[0].calls[0].value!)).toBe(AMOUNT);
    // …and the sell carries no value: it spends tokens, not ETH.
    expect(seen[1].calls[seen[1].calls.length - 1].value).toBe('0x0');
  });
});

describe('an RPC failure is a REJECTION, never a pass', () => {
  it('rejects when the probe simulation throws', async () => {
    const rpc: EvmRpc = {
      call: async () => '0x',
      getLogs: async () => [],
      simulate: async () => { throw new Error('HTTP 503'); },
    };
    const r = await runPreTradeGates({
      rpc, route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'gate_rpc_failed' });
  });

  it('rejects when the round-trip simulation throws', async () => {
    let n = 0;
    const rpc: EvmRpc = {
      call: async () => '0x',
      getLogs: async () => [],
      simulate: async () => {
        if (n++ === 0) return [ok(), tokensOut(1n)];
        throw new Error('node went away');
      },
    };
    const r = await runPreTradeGates({
      rpc, route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'gate_rpc_failed' });
  });

  it('rejects a truncated simulation response rather than reading past it', async () => {
    const r = await runPreTradeGates({
      rpc: scriptedRpc([[ok()]]),
      route: v3Route, token: TOKEN, amountInWei: AMOUNT, deadline: DEADLINE, config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: 'gate_rpc_failed' });
  });
});
