// Robinhood Chain: the chain definition and the address book.
//
// EVERY address in this file was verified against the live RPC on 2026-09-04,
// and each one carries the call that proved it. Nothing here was copied from a
// block explorer's label or from another chain's deployment — a wrong router
// address on a money path does not fail loudly, it sends ETH to a contract that
// happily accepts it.
//
// How to re-verify (all of it is read-only `eth_call`):
//
//   chainId      eth_chainId                     -> 0x1237 (4663)
//   client       web3_clientVersion              -> nitro/v3.11.4-rc.3 (Arbitrum Orbit L3)
//   WETH         WETH.symbol()/decimals()        -> "WETH" / 18
//   V3 factory   SwapRouter02.factory()          -> 0x1f7d…2efa  (and a live V3 pool's factory() agrees)
//   SwapRouter02 SwapRouter02.WETH9()            -> 0x0Bd7…aD73  (the same WETH below)
//   PoolManager  UniversalRouter.poolManager()   -> 0x8366…0951
//
// The two routers were not guessed: they were found by reading `Swap` logs off
// live V3 pools, taking the `to` of each emitting transaction, and keeping the
// ones whose self-describing getters agreed with the rest of the address book.

import { defineChain } from 'viem';

/**
 * chainId 4663 = 0x1237. Confirmed by `eth_chainId` on the public RPC, and it
 * matches the `networkId: 4663` j7 already carries in its payloads.
 */
export const ROBINHOOD_CHAIN_ID = 4663;

export const ROBINHOOD_DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/**
 * The viem chain. Built with `defineChain` rather than imported from
 * `viem/chains` because Robinhood Chain is not in viem's registry.
 *
 * `multicall3` is deliberately ABSENT. viem will happily batch reads through a
 * Multicall3 address if you declare one, and declaring an unverified address
 * would silently route every read through a contract nobody checked. Reads here
 * are few and sequential; batching is not worth an unverified address.
 */
export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_DEFAULT_RPC_URL] } },
});

/**
 * Wrapped native ETH.
 *
 * Verified: `symbol()` -> "WETH", `decimals()` -> 18, and — the check that
 * actually matters — `SwapRouter02.WETH9()` returns this exact address, so the
 * router we spend through and the token we wrap into are the same contract.
 * DexScreener independently reports it as the quote token on every V3 pair on
 * this chain.
 */
export const WETH_ADDRESS = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const;

/**
 * Uniswap V3 factory. Verified two independent ways: a live V3 pool
 * (0x8AAc0c4c…8C7A) returns it from `factory()`, and SwapRouter02 returns the
 * same address from its own `factory()`. Not currently called at runtime — it
 * is here because the pool-provenance check below is the natural place to grow
 * one, and because recording it is how the router address stays falsifiable.
 */
export const UNISWAP_V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as const;

/**
 * Uniswap SwapRouter02 — the V3 execution path.
 *
 * Found empirically: it is the `to` of the clear majority of transactions that
 * emit a V3 `Swap` on this chain, calling selector 0x5ae401dc
 * (`multicall(uint256,bytes[])`, the SwapRouter02 signature). Confirmed by its
 * own getters: `factory()` -> the V3 factory above, `WETH9()` -> the WETH above.
 * Both agreeing is what rules out a look-alike aggregator.
 */
export const UNISWAP_SWAP_ROUTER_02 = '0xCaf681a66D020601342297493863E78C959E5cb2' as const;

/**
 * Uniswap Universal Router — the V4 execution path.
 *
 * Found the same way (it appears as the `to` of V3-swap-emitting transactions
 * calling 0x3593564c = `execute(bytes,bytes[],uint256)`), and confirmed by
 * `poolManager()` returning the V4 PoolManager below. A contract that knows the
 * PoolManager and speaks `execute` is the Universal Router.
 */
export const UNISWAP_UNIVERSAL_ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904' as const;

/**
 * Uniswap V4 PoolManager (the singleton every V4 pool lives inside).
 * Verified: `UniversalRouter.poolManager()` returns exactly this.
 */
export const UNISWAP_V4_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const;

/**
 * `Initialize(bytes32 indexed id, address indexed currency0, address indexed
 * currency1, uint24 fee, int24 tickSpacing, address hooks, uint160
 * sqrtPriceX96, int24 tick)` — the V4 PoolManager event that is the only
 * on-chain record of a pool's PoolKey.
 *
 * DexScreener reports a V4 "pair address" that is really the 32-byte poolId, and
 * a poolId is a hash: it cannot be reversed into the PoolKey a swap needs. This
 * topic, filtered by that poolId, recovers the key in one `eth_getLogs`.
 */
export const V4_INITIALIZE_TOPIC =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438' as const;

/**
 * The V4 spelling of native ETH. V4 trades native currency directly — there is
 * no wrap step and no WETH involved — and represents it as the zero address.
 */
export const V4_NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000' as const;

/**
 * DexScreener's slug for this chain. Verified by observation: pairs on
 * `api.dexscreener.com` come back with `chainId: "robinhood"`, and the quote
 * tokens on those pairs are the WETH above. This is a wire value, not a guess —
 * if DexScreener renames it, pool discovery returns nothing and the executor
 * refuses to fire, which is the safe direction.
 */
export const DEXSCREENER_CHAIN_SLUG = 'robinhood' as const;
