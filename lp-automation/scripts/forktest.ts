// Fork test: prove the broadcast path with ZERO real funds.
//
//   npm run forktest            # compound + rebalance
//   npm run forktest:compound
//   npm run forktest:rebalance
//
// Spins up an anvil fork of Robinhood Chain (a local copy of current mainnet
// state), runs the REAL production path — operator key -> module.execute ->
// Safe -> Krystal calldata — as a genuinely signed transaction, and inspects
// the on-chain result. The tx lands on the local fork, so nothing real moves.
// Tears the fork down on exit.
//
// Requires: Foundry (anvil) on PATH or under ~/.foundry/bin, and a configured
// .env (LP_RPC_WS_URL or LP_RPC_URL to fork from, LP_SAFE_ADDRESS,
// LP_MODULE_ADDRESS, LP_OPERATOR_PRIVATE_KEY).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseAbi, type Account, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildCompound, buildAdjustRange } from '../src/calldata/lpTxn.js';
import { recenterRange } from '../src/lifecycle/range.js';

const PORT = 8546;
const FORK = `http://127.0.0.1:${PORT}`;
const V3UTILS = '0xb4acbc082b5e7ded571c98ee4257778a9d784b36' as Address;
const NFPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3' as Address;
const FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address;

const env = (k: string): string => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is not set in lp-automation/.env`);
  return v;
};
const redact = (u: string) => u.replace(/(\/v2\/).*/, '$1<redacted>');
const L = (s = '') => console.log(s);

function findAnvil(): string {
  const candidates = [
    join(homedir(), '.foundry', 'bin', 'anvil'),
    join(homedir(), '.foundry', 'bin', 'anvil.exe'),
    'anvil',
  ];
  return candidates.find((c) => c === 'anvil' || existsSync(c)) ?? 'anvil';
}

async function waitForRpc(timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(FORK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error('anvil did not become ready in time');
    await new Promise((res) => setTimeout(res, 500));
  }
}

const CHAIN = {
  id: 4663,
  name: 'robinhood-fork',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [FORK] } },
} as const;

const NFPM_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 f0,uint256 f1,uint128 owed0,uint128 owed1)',
]);
const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 a,uint16 b,uint16 c,uint8 d,bool e)',
]);
const FACTORY_ABI = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const MODULE_ABI = parseAbi(['function execute(address to,uint256 value,bytes data) returns (bytes)']);
// event topics
const T_COLLECT = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const T_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';

type Ctx = {
  pub: ReturnType<typeof createPublicClient>;
  wallet: ReturnType<typeof createWalletClient>;
  // The LOCAL account object, not the address. simulateContract must receive
  // this — pass the address string instead and viem builds a json-rpc account,
  // so writeContract asks the node to sign, which anvil can't do for a real key
  // ("No Signer available"). This is the same trap the signer's clients.ts warns
  // about.
  account: Account;
  operator: Address;
  safe: Address;
  module: Address;
};

interface ActivePosition {
  tokenId: bigint;
  feeBps: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  currentTick: number;
}

async function findActivePosition(ctx: Ctx): Promise<ActivePosition> {
  const bal = await ctx.pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: 'balanceOf', args: [ctx.safe] });
  for (let i = 0n; i < bal; i++) {
    const id = await ctx.pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [ctx.safe, i] });
    const p = await ctx.pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: 'positions', args: [id] });
    if (p[7] > 0n) {
      const pool = await ctx.pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getPool', args: [p[2], p[3], p[4]] });
      const slot0 = await ctx.pub.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' });
      return { tokenId: id, feeBps: Number(p[4]), tickLower: Number(p[5]), tickUpper: Number(p[6]), liquidity: p[7], currentTick: Number(slot0[1]) };
    }
  }
  throw new Error(`no active position (liquidity > 0) found for Safe ${ctx.safe}`);
}

function calldataPolicy(safe: Address) {
  return {
    chainId: 4663,
    platform: 'uniswapv3',
    allowedTargets: [V3UTILS.toLowerCase() as Address, NFPM.toLowerCase() as Address],
    expectedFrom: safe.toLowerCase() as Address,
    // Compound and adjust_range carry zero native value, so a 0 ceiling is
    // correct here and mirrors what the operator's own policy enforces.
    maxValueWei: 0n,
  };
}

async function runCompound(ctx: Ctx, pos: ActivePosition): Promise<void> {
  L('\n=== COMPOUND ===');
  const before = pos.liquidity;
  const prepared = await buildCompound({ policy: calldataPolicy(ctx.safe), platformWallet: ctx.safe }, { tokenId: pos.tokenId.toString(), swapSlippage: 0.01, liquiditySlippage: 0.01 });
  L(`  calldata to ${prepared.to} selector ${prepared.data.slice(0, 10)}`);
  const { request } = await ctx.pub.simulateContract({ account: ctx.account, address: ctx.module, abi: MODULE_ABI, functionName: 'execute', args: [prepared.to, prepared.value, prepared.data] });
  const hash = await ctx.wallet.writeContract(request);
  const rc = await ctx.pub.waitForTransactionReceipt({ hash });
  const collected = rc.logs.some((l) => l.topics[0] === T_COLLECT);
  const increased = rc.logs.some((l) => l.topics[0] === T_INCREASE);
  const after = await ctx.pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: 'positions', args: [pos.tokenId] });
  L(`  status ${rc.status} · gas ${rc.gasUsed} · Collect=${collected} IncreaseLiquidity=${increased}`);
  L(`  liquidity ${before} -> ${after[7]}  (owed0 ${after[10]}, owed1 ${after[11]})`);
  const ok = rc.status === 'success' && collected && increased && after[10] === 0n && after[11] === 0n;
  L(ok ? '  PASS: fees claimed and compounded back in.' : '  CHECK: unexpected result.');
  if (!ok) process.exitCode = 1;
}

async function runRebalance(ctx: Ctx, pos: ActivePosition): Promise<void> {
  L('\n=== REBALANCE (narrow) ===');
  const rc0 = recenterRange({ tokenId: pos.tokenId.toString(), currentTick: pos.currentTick, tickLower: pos.tickLower, tickUpper: pos.tickUpper, pool: { feeTierBps: pos.feeBps } } as never, 'narrow');
  if (!rc0.ok) { L(`  recenterRange refused: ${rc0.reason}`); process.exitCode = 1; return; }
  const spacing = pos.feeBps === 10000 ? 200 : pos.feeBps === 3000 ? 60 : pos.feeBps === 500 ? 10 : 1;
  const aligned = rc0.range.tickLower % spacing === 0 && rc0.range.tickUpper % spacing === 0;
  L(`  target [${rc0.range.tickLower}, ${rc0.range.tickUpper}] aligned=${aligned}`);
  const prepared = await buildAdjustRange({ policy: calldataPolicy(ctx.safe), platformWallet: ctx.safe }, { tokenId: pos.tokenId.toString(), newTickLower: rc0.range.tickLower, newTickUpper: rc0.range.tickUpper, swapSlippage: 0.01, liquiditySlippage: 0.01 });
  const { request } = await ctx.pub.simulateContract({ account: ctx.account, address: ctx.module, abi: MODULE_ABI, functionName: 'execute', args: [prepared.to, prepared.value, prepared.data] });
  const hash = await ctx.wallet.writeContract(request);
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
  const old = await ctx.pub.readContract({ address: NFPM, abi: NFPM_ABI, functionName: 'positions', args: [pos.tokenId] });
  const next = await findActivePosition(ctx).catch(() => null);
  // "Drained" rather than "exactly zero". Krystal builds calldata against real
  // mainnet state; when a compound ran first on this fork, the fork has diverged
  // and a sliver of the just-added liquidity is left behind (a fork artifact,
  // not a production one — on-chain, Krystal sees the true post-compound state).
  // Running `forktest:rebalance` alone drains to exactly 0.
  const drainedPct = pos.liquidity > 0n ? Number((old[7] * 10000n) / pos.liquidity) / 100 : 0;
  L(`  status ${receipt.status} · gas ${receipt.gasUsed}`);
  L(`  old position #${pos.tokenId} liquidity -> ${old[7]}  (${(100 - drainedPct).toFixed(2)}% withdrawn)`);
  if (next && next.tokenId !== pos.tokenId) L(`  new position #${next.tokenId} range [${next.tickLower}, ${next.tickUpper}] liquidity ${next.liquidity}`);
  const ok = receipt.status === 'success' && drainedPct < 1 && !!next && next.tokenId !== pos.tokenId && aligned;
  L(ok ? '  PASS: position withdrawn and re-minted at the narrow band.' : '  CHECK: unexpected result.');
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const which = (process.argv[2] ?? 'all').toLowerCase();
  const forkUrl = (process.env.LP_RPC_WS_URL ?? process.env.LP_RPC_URL ?? '').trim().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  if (!forkUrl) throw new Error('need LP_RPC_WS_URL or LP_RPC_URL to fork from');

  L(`forking ${redact(forkUrl)} -> ${FORK}`);
  const anvil: ChildProcess = spawn(findAnvil(), ['--fork-url', forkUrl, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
  const cleanup = () => { try { anvil.kill(); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    await waitForRpc();
    const account = privateKeyToAccount(env('LP_OPERATOR_PRIVATE_KEY') as `0x${string}`);
    const ctx: Ctx = {
      pub: createPublicClient({ chain: CHAIN, transport: http(FORK) }),
      wallet: createWalletClient({ account, chain: CHAIN, transport: http(FORK) }),
      account,
      operator: account.address,
      safe: env('LP_SAFE_ADDRESS') as Address,
      module: env('LP_MODULE_ADDRESS') as Address,
    };
    const pos = await findActivePosition(ctx);
    L(`position #${pos.tokenId} · fee ${pos.feeBps}bps · range [${pos.tickLower}, ${pos.tickUpper}] · currentTick ${pos.currentTick}`);

    if (which === 'compound' || which === 'all') await runCompound(ctx, pos);
    if (which === 'rebalance' || which === 'all') {
      // Re-read the position after a compound so rebalance sees fresh state.
      const fresh = which === 'all' ? await findActivePosition(ctx) : pos;
      await runRebalance(ctx, fresh);
    }
    L('\nDone. Nothing real moved — this ran entirely on the local fork.');
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error('forktest failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
