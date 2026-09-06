// Swap calldata construction, for both Uniswap families.
//
// THE POINT OF THIS FILE IS THAT THERE IS EXACTLY ONE OF IT. The sell-simulation
// gate and the real send both build their calldata here, from the same route and
// the same amounts. If simulation encoded the swap even slightly differently
// from execution — a different fee tier, a different recipient, a different
// router — the gate would be certifying a transaction that is not the one we
// send, which is worse than having no gate at all: it is a gate that reports
// success for something else.
//
// Everything here is pure. No network, no key, no clock beyond the deadline the
// caller passes in.

import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from 'viem';

import { UNISWAP_SWAP_ROUTER_02, UNISWAP_UNIVERSAL_ROUTER, WETH_ADDRESS } from './chain.js';
import type { Route, V4PoolKey } from './routing.js';

/**
 * Permit2, at its canonical cross-chain address. Verified present on Robinhood
 * Chain by `eth_getCode` returning a non-empty body at this address.
 *
 * It is only reachable on the SELL side of a V4 simulation: settling a token
 * INTO the PoolManager through the Universal Router pulls it via Permit2. The
 * buy side spends native ETH, which needs no allowance and never touches this
 * contract — so no real fire this module performs involves Permit2 at all.
 */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export const SWAP_ROUTER_02_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);

export const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

export const PERMIT2_ABI = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

/** `type(uint256).max` — the standard "approve once" amount. */
export const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

// ---------------------------------------------------------------------------
// Universal Router / V4 opcodes
// ---------------------------------------------------------------------------
//
// These are protocol constants, not configuration. Spelled out with their
// meanings because a wrong byte here does not revert cleanly — it dispatches to
// a different action with the same calldata.

/** Universal Router command: hand the payload to the V4 router logic. */
const CMD_V4_SWAP = 0x10;
/** V4 action: one-hop exact-input swap. */
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
/** V4 action: pay everything owed on the input currency. */
const ACT_SETTLE_ALL = 0x0c;
/** V4 action: collect everything owed to us on the output currency. */
const ACT_TAKE_ALL = 0x0f;

const V4_EXACT_IN_SINGLE_PARAMS = parseAbiParameters([
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)',
]);
const V4_CURRENCY_AMOUNT = parseAbiParameters('address currency, uint256 amount');

const hexByte = (b: number): string => b.toString(16).padStart(2, '0');

// ---------------------------------------------------------------------------
// The built transaction
// ---------------------------------------------------------------------------

/** A ready-to-send (or ready-to-simulate) call. */
export interface SwapTx {
  to: string;
  data: string;
  /** wei. Zero for a sell. */
  value: bigint;
}

export interface BuildSwapParams {
  route: Route;
  /** The token being bought (buy) or sold (sell). */
  token: string;
  /** Native wei in (buy) or token units in (sell). */
  amountIn: bigint;
  /** Slippage floor, already computed by the caller. */
  amountOutMinimum: bigint;
  /** Unix seconds. */
  deadline: bigint;
  /** Who receives the output. */
  recipient: string;
}

/**
 * Apply a basis-point slippage tolerance to an expected output.
 *
 * Rounds DOWN (integer division), which loosens the floor by at most one wei
 * and can therefore never make a swap revert that should have succeeded.
 * Rounding up would tighten it, and a floor tightened by rounding is a swap that
 * fails for a reason nobody can see in the parameters.
 */
export function applySlippage(expectedOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (expectedOut * (10_000n - bps)) / 10_000n;
}

// ---------------------------------------------------------------------------
// Buy: native ETH -> token
// ---------------------------------------------------------------------------

export function buildBuyTx(p: BuildSwapParams): SwapTx {
  if (p.route.family === 'uniswap_v3') {
    // SwapRouter02's `exactInputSingle` carries no deadline of its own — the
    // deadline lives on `multicall`, which is why the swap is wrapped in one
    // even though there is a single call inside. Sending it bare would submit a
    // swap with NO deadline, which on a congested block is a free option handed
    // to whoever mines it.
    const inner = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          // tokenIn is WETH, not the zero address: SwapRouter02 wraps the
          // native `value` itself when `tokenIn == WETH9` and the router holds
          // the balance. That is the whole native-in path — there is no
          // separate deposit() call to get wrong.
          tokenIn: WETH_ADDRESS,
          tokenOut: p.token as `0x${string}`,
          fee: p.route.fee,
          recipient: p.recipient as `0x${string}`,
          amountIn: p.amountIn,
          amountOutMinimum: p.amountOutMinimum,
          // 0 = no price limit. The slippage floor above is the protection;
          // a sqrt-price limit would silently PARTIAL-fill instead of
          // reverting, leaving an unknown amount spent — the one outcome the
          // fire log cannot represent honestly.
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return {
      to: UNISWAP_SWAP_ROUTER_02,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_02_ABI,
        functionName: 'multicall',
        args: [p.deadline, [inner]],
      }),
      value: p.amountIn,
    };
  }

  const { poolKey, zeroForOne } = p.route;
  return {
    to: UNISWAP_UNIVERSAL_ROUTER,
    data: encodeUniversalV4Swap({
      poolKey,
      // Buying the token means spending native ETH, which is currency0 whenever
      // it is present — `zeroForOne` was resolved against the real PoolKey in
      // routing.ts rather than assumed here.
      zeroForOne,
      amountIn: p.amountIn,
      amountOutMinimum: p.amountOutMinimum,
      currencyIn: zeroForOne ? poolKey.currency0 : poolKey.currency1,
      currencyOut: zeroForOne ? poolKey.currency1 : poolKey.currency0,
      deadline: p.deadline,
    }),
    value: p.amountIn,
  };
}

// ---------------------------------------------------------------------------
// Sell: token -> native (V4) / token -> WETH (V3)
// ---------------------------------------------------------------------------

/**
 * The reverse swap, used ONLY by the simulation gate. Nothing in this module
 * ever broadcasts a sell — exits are the operator's, deliberately.
 *
 * On V3 the output is WETH rather than unwrapped ETH. That is not a shortcut:
 * `WETH.withdraw` cannot fail for a balance you hold, so WETH-out and ETH-out
 * are the same fact about sellability, and skipping the unwrap keeps the
 * simulated sell byte-identical in structure to the simulated buy.
 */
export function buildSellTx(p: BuildSwapParams): SwapTx {
  if (p.route.family === 'uniswap_v3') {
    const inner = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: p.token as `0x${string}`,
          tokenOut: WETH_ADDRESS,
          fee: p.route.fee,
          recipient: p.recipient as `0x${string}`,
          amountIn: p.amountIn,
          amountOutMinimum: p.amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return {
      to: UNISWAP_SWAP_ROUTER_02,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_02_ABI,
        functionName: 'multicall',
        args: [p.deadline, [inner]],
      }),
      value: 0n,
    };
  }

  const { poolKey, zeroForOne } = p.route;
  // Selling is the opposite direction of the buy.
  const sellZeroForOne = !zeroForOne;
  return {
    to: UNISWAP_UNIVERSAL_ROUTER,
    data: encodeUniversalV4Swap({
      poolKey,
      zeroForOne: sellZeroForOne,
      amountIn: p.amountIn,
      amountOutMinimum: p.amountOutMinimum,
      currencyIn: sellZeroForOne ? poolKey.currency0 : poolKey.currency1,
      currencyOut: sellZeroForOne ? poolKey.currency1 : poolKey.currency0,
      deadline: p.deadline,
    }),
    value: 0n,
  };
}

// ---------------------------------------------------------------------------
// V4 encoding
// ---------------------------------------------------------------------------

/**
 * `UniversalRouter.execute(commands, inputs, deadline)` for a single V4 hop.
 *
 * The nesting is unusual enough to be worth naming: `commands` is a byte string
 * of router opcodes, `inputs[i]` is that opcode's payload, and for V4_SWAP that
 * payload is ITSELF an (actions, params[]) pair in the same shape one level
 * down. So a one-hop swap is three V4 actions (swap, settle what we owe, take
 * what we are owed) inside one router command.
 */
function encodeUniversalV4Swap(a: {
  poolKey: V4PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  currencyIn: string;
  currencyOut: string;
  deadline: bigint;
}): string {
  const actions = `0x${hexByte(ACT_SWAP_EXACT_IN_SINGLE)}${hexByte(ACT_SETTLE_ALL)}${hexByte(ACT_TAKE_ALL)}` as const;

  const swapParams = encodeAbiParameters(V4_EXACT_IN_SINGLE_PARAMS, [
    {
      poolKey: {
        currency0: a.poolKey.currency0 as `0x${string}`,
        currency1: a.poolKey.currency1 as `0x${string}`,
        fee: a.poolKey.fee,
        tickSpacing: a.poolKey.tickSpacing,
        hooks: a.poolKey.hooks as `0x${string}`,
      },
      zeroForOne: a.zeroForOne,
      amountIn: a.amountIn,
      amountOutMinimum: a.amountOutMinimum,
      // No hook payload. Every V4 pool observed on this chain carries a hook,
      // and all of them are fee hooks that read nothing from hookData; sending
      // a guessed payload to an unknown hook is strictly worse than sending
      // none. If a pool needs hookData, its swap reverts and the gate catches
      // it before any money moves.
      hookData: '0x',
    },
  ]);

  // SETTLE_ALL's second field is a MAXIMUM to pay, TAKE_ALL's is a MINIMUM to
  // receive. They are not the same kind of number despite the identical ABI,
  // and swapping them turns the output floor into an input ceiling.
  const settleParams = encodeAbiParameters(V4_CURRENCY_AMOUNT, [a.currencyIn as `0x${string}`, a.amountIn]);
  const takeParams = encodeAbiParameters(V4_CURRENCY_AMOUNT, [
    a.currencyOut as `0x${string}`,
    a.amountOutMinimum,
  ]);

  const v4Input = encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), [
    actions,
    [swapParams, settleParams, takeParams],
  ]);

  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [`0x${hexByte(CMD_V4_SWAP)}`, [v4Input], a.deadline],
  });
}

// ---------------------------------------------------------------------------
// Approvals — simulation only
// ---------------------------------------------------------------------------

/**
 * The approvals a simulated SELL needs, in order. Never broadcast.
 *
 * V3 pulls the token straight from the seller, so one ERC20 allowance to
 * SwapRouter02 is enough. V4 pulls it through Permit2, which needs two: the
 * ERC20 allowance to Permit2, then a Permit2 allowance to the Universal Router.
 * Both are part of the simulation precisely so the gate measures the exit an
 * operator would actually have to perform, not an idealised one.
 */
export function buildSellApprovals(route: Route, token: string): { to: string; data: string }[] {
  const approveErc20 = (spender: string): { to: string; data: string } => ({
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender as `0x${string}`, MAX_UINT256] }),
  });

  if (route.family === 'uniswap_v3') return [approveErc20(UNISWAP_SWAP_ROUTER_02)];

  return [
    approveErc20(PERMIT2_ADDRESS),
    {
      to: PERMIT2_ADDRESS,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [token as `0x${string}`, UNISWAP_UNIVERSAL_ROUTER, MAX_UINT160, Number(MAX_UINT48)],
      }),
    },
  ];
}

/** `balanceOf(owner)` calldata, for reading a simulated position mid-sequence. */
export function encodeBalanceOf(owner: string): string {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [owner as `0x${string}`] });
}
