// Env configuration for the EVM sniper.
//
// The governing rule of this file: EVERY read fails toward LESS spending.
//
// A missing var, a typo, `"0.1 ETH"`, `"1e9"`, `Infinity`, `NaN`, a negative
// number — all of them collapse to the built-in default, never to "unbounded"
// and never to "off" for a control that exists to refuse. That is not defensive
// style for its own sake: the source channel this module listens to scans on the
// order of 234 tokens a day, so an EVM sniper that silently loses its daily cap
// attempts ~2.34 ETH of buys before anyone notices. `parseAmount` below is the
// single funnel every numeric knob goes through, so there is one place that can
// be wrong rather than nine.
//
// Everything here is a PURE function of an injected env bag. Nothing is read at
// module load, nothing is cached in module state, and `SNIPER_EVM_PRIVATE_KEY`
// is not read in this file at all — see executors/evmUniswap.ts for why it is
// read inside the fire call frame instead.

import { ROBINHOOD_DEFAULT_RPC_URL } from './chain.js';

/** The environment as this module consumes it. Injected so tests need no `process.env` mutation. */
export type EnvBag = Record<string, string | undefined>;

export interface EvmSniperConfig {
  /** ETH spent per fire, before fees. */
  buyEth: number;
  /** ETH per UTC day across every fire. The governing control. */
  dailyCapEth: number;
  /** Swap slippage tolerance, basis points. */
  slippageBps: number;
  /** A pool below this much quoted USD liquidity is not a tradeable pool. */
  minLiquidityUsd: number;
  /** Round-trip floor: simulated ETH back, as bps of ETH in. Below this, the token is unsellable. */
  minRoundTripBps: number;
  /** Both gates default ON; these exist so an operator can disable one deliberately. */
  liquidityGateEnabled: boolean;
  sellSimGateEnabled: boolean;
  /** Swap deadline, seconds from submission. */
  deadlineSeconds: number;
  rpcUrl: string;
  /**
   * Telegram chat ids that may trigger a fire. EMPTY MEANS NO TRIGGER FIRES —
   * this is the one setting with no usable default, so it has none.
   */
  triggerChatIds: ReadonlySet<string>;
  /**
   * The wallet the operator declares they funded and capped, if they declared
   * one. Optional, but when set the executor refuses to fire from any other
   * address — see `assertDeclaredWallet` in the executor.
   */
  declaredWalletAddress: string | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
//
// Exported so the tests assert against the same constants the code uses, rather
// than against numbers retyped in a test file that can drift from these.

export const DEFAULT_BUY_ETH = 0.01;
export const DEFAULT_DAILY_CAP_ETH = 0.1;
export const DEFAULT_SLIPPAGE_BPS = 500; // 5% — a new-pair snipe on a thin L3 pool
export const DEFAULT_MIN_LIQUIDITY_USD = 5_000;
/**
 * 5000bps = 50% of the ETH must come back in simulation.
 *
 * Sized to catch "unsellable", not to second-guess ordinary tokens. A normal
 * round trip through a 1% pool returns ~98%; a 10%-sell-tax token returns ~88%.
 * Anything under half is a honeypot, a punitive tax, or a pool too thin to
 * round-trip the size we are about to send — all three are the same answer.
 */
export const DEFAULT_MIN_ROUNDTRIP_BPS = 5_000;
export const DEFAULT_DEADLINE_SECONDS = 120;

/**
 * A hard ceiling on the daily cap, independent of what the env says.
 *
 * The env default cannot be raised by accident, but it CAN be raised on
 * purpose, and a fat finger on a purposeful edit (`1` where `0.1` was meant) is
 * exactly the failure this module exists to prevent. 1 ETH/day is far above the
 * operator's stated 0.1 and far below anything that could be called a runaway.
 * A value over this is clamped down to it, loudly.
 */
export const MAX_DAILY_CAP_ETH = 1;

/** Likewise for a single fire. 0.1 ETH is 10x the stated size; past that, refuse to believe it. */
export const MAX_BUY_ETH = 0.1;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The one numeric funnel. Returns `fallback` for anything that is not a real,
 * finite, positive number, and clamps to `max` when one is given.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, so an operator who writes
 * `SNIPER_EVM_DAILY_CAP_ETH=` (a half-finished edit) would get a cap of zero —
 * which refuses every fire rather than allowing them, but reads to the operator
 * as a broken module rather than a misconfiguration. Treating empty as absent
 * and using the default is both safer and more honest.
 *
 * `Number('1e9')` is a valid finite number, and it is also a cap that does not
 * cap. That is what `max` is for.
 */
export function parseAmount(
  raw: string | undefined,
  fallback: number,
  opts: { max?: number; label?: string } = {},
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;

  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[sniper/evm] ${opts.label ?? 'value'} "${trimmed}" is not a positive number; using ${fallback}.`,
    );
    return fallback;
  }
  if (opts.max !== undefined && n > opts.max) {
    console.warn(
      `[sniper/evm] ${opts.label ?? 'value'} ${n} exceeds the hard ceiling ${opts.max}; clamping to ${opts.max}.`,
    );
    return opts.max;
  }
  return n;
}

/** Integer knobs (bps, seconds). Same fail-toward-default contract as parseAmount. */
export function parseIntIn(
  raw: string | undefined,
  fallback: number,
  lo: number,
  hi: number,
  label: string,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;

  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi) {
    console.warn(`[sniper/evm] ${label} "${trimmed}" is not an integer in ${lo}..${hi}; using ${fallback}.`);
    return fallback;
  }
  return n;
}

/**
 * Booleans for the two pre-trade gates.
 *
 * DEFAULTS TRUE, and only an explicit, recognised falsey spelling turns a gate
 * off. Matching only `'0'` would fail OPEN for `SNIPER_EVM_LIQUIDITY_GATE=false`
 * — the operator would believe they had disabled it while it stayed on, or
 * (worse, with the polarity flipped) believe it was on while it was off. The
 * same reasoning as `processDryRun` in executors/registry.ts, in the opposite
 * direction: there, unknown input means "dry run"; here, unknown input means
 * "gate stays on". Both directions are "spend less".
 */
export function parseGateEnabled(raw: string | undefined, label: string): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  console.warn(`[sniper/evm] ${label} "${v}" is not a recognised boolean; the gate stays ON.`);
  return true;
}

/**
 * The trigger allowlist.
 *
 * Telegram chat ids arrive from `TelegramRawMessage.chatId` as STRINGS in
 * Bot-API form (`-100…` for a supergroup/channel), so the allowlist is a string
 * set and not a number set — round-tripping a `-1001234567890` through `Number`
 * is lossless today but pointless, and it would quietly start truncating if
 * Telegram ever widened the id space.
 *
 * FAILS CLOSED. Unset, empty, or all-garbage yields an empty set, and an empty
 * set fires on nothing. This is the exact opposite of `tgbot/access.ts`, whose
 * `null` means "serve everyone" — that default is right for a read-only alert
 * bot and catastrophic for a module that spends, so the two must not share a
 * parser however similar they look.
 */
export function parseTriggerChatIds(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const piece of (raw ?? '').split(',')) {
    const id = piece.trim();
    if (!id) continue;
    // Bot-API chat ids are decimal integers, optionally negative. Anything else
    // is a typo (a @username, a t.me link, a quoted string) and is dropped
    // rather than added — a bad entry must never widen the gate.
    if (!/^-?\d{1,20}$/.test(id)) {
      console.warn(`[sniper/evm] ignoring malformed trigger chat id "${id}".`);
      continue;
    }
    out.add(id);
  }
  return out;
}

/** EIP-55-agnostic address shape check. Case is not validated; callers lowercase for comparison. */
export function parseAddress(raw: string | undefined, label: string): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    console.warn(`[sniper/evm] ${label} "${v}" is not a 20-byte hex address; ignoring it.`);
    return null;
  }
  return v;
}

/**
 * The RPC endpoint.
 *
 * Constrained to http(s) and defaulted rather than interpolated: this URL is
 * the destination of every read the gates depend on, so a `file://` or a
 * attacker-shaped value would turn the gates into an SSRF primitive. Same
 * argument as `narrowRegion` in executors/slotshark.ts.
 */
export function parseRpcUrl(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) return ROBINHOOD_DEFAULT_RPC_URL;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      console.warn(`[sniper/evm] SNIPER_EVM_RPC_URL protocol "${u.protocol}" is not http(s); using the default RPC.`);
      return ROBINHOOD_DEFAULT_RPC_URL;
    }
    return v;
  } catch {
    console.warn('[sniper/evm] SNIPER_EVM_RPC_URL is not a valid URL; using the default RPC.');
    return ROBINHOOD_DEFAULT_RPC_URL;
  }
}

/**
 * Is a signing key configured?
 *
 * Returns a BOOLEAN and nothing else. `fireOrchestrator` needs to refuse early
 * when no key is present, and it must be able to do that without the key value
 * entering its call frame — so the one function that answers the question
 * returns one bit. Nothing here logs, returns, or derives anything from the
 * value: not its length, not its prefix, not a fingerprint.
 *
 * Deliberately NOT part of `EvmSniperConfig`: putting it on the config object
 * would tempt a caller to cache the answer, and whether a key is present is a
 * property of this instant, not of a parsed configuration.
 */
export function hasEvmSigningKey(env: EnvBag = process.env): boolean {
  return Boolean(env.SNIPER_EVM_PRIVATE_KEY?.trim());
}

/** Read the whole configuration. Pure over `env`; safe to call as often as you like. */
export function readEvmSniperConfig(env: EnvBag = process.env): EvmSniperConfig {
  const buyEth = parseAmount(env.SNIPER_EVM_BUY_ETH, DEFAULT_BUY_ETH, {
    max: MAX_BUY_ETH,
    label: 'SNIPER_EVM_BUY_ETH',
  });
  let dailyCapEth = parseAmount(env.SNIPER_EVM_DAILY_CAP_ETH, DEFAULT_DAILY_CAP_ETH, {
    max: MAX_DAILY_CAP_ETH,
    label: 'SNIPER_EVM_DAILY_CAP_ETH',
  });

  // A daily cap below one fire is not a cap, it is an outage that looks like a
  // bug: every fire would be refused with `daily_cap` and nothing would explain
  // why. Raise the cap to exactly one fire and say so. This is the ONLY place
  // anything moves upward, it moves to the smallest spending value that can
  // function, and it can never exceed the operator's own per-fire size.
  if (dailyCapEth < buyEth) {
    console.warn(
      `[sniper/evm] daily cap ${dailyCapEth} ETH is below the per-fire size ${buyEth} ETH; ` +
        `raising it to one fire. Lower SNIPER_EVM_BUY_ETH if that is not what you want.`,
    );
    dailyCapEth = buyEth;
  }

  return {
    buyEth,
    dailyCapEth,
    slippageBps: parseIntIn(env.SNIPER_EVM_SLIPPAGE_BPS, DEFAULT_SLIPPAGE_BPS, 1, 10_000, 'SNIPER_EVM_SLIPPAGE_BPS'),
    minLiquidityUsd: parseAmount(env.SNIPER_EVM_MIN_LIQUIDITY_USD, DEFAULT_MIN_LIQUIDITY_USD, {
      label: 'SNIPER_EVM_MIN_LIQUIDITY_USD',
    }),
    minRoundTripBps: parseIntIn(
      env.SNIPER_EVM_MIN_ROUNDTRIP_BPS,
      DEFAULT_MIN_ROUNDTRIP_BPS,
      1,
      10_000,
      'SNIPER_EVM_MIN_ROUNDTRIP_BPS',
    ),
    liquidityGateEnabled: parseGateEnabled(env.SNIPER_EVM_LIQUIDITY_GATE, 'SNIPER_EVM_LIQUIDITY_GATE'),
    sellSimGateEnabled: parseGateEnabled(env.SNIPER_EVM_SELL_SIM_GATE, 'SNIPER_EVM_SELL_SIM_GATE'),
    deadlineSeconds: parseIntIn(
      env.SNIPER_EVM_DEADLINE_SECONDS,
      DEFAULT_DEADLINE_SECONDS,
      5,
      3_600,
      'SNIPER_EVM_DEADLINE_SECONDS',
    ),
    rpcUrl: parseRpcUrl(env.SNIPER_EVM_RPC_URL),
    triggerChatIds: parseTriggerChatIds(env.SNIPER_EVM_TRIGGER_CHAT_IDS),
    declaredWalletAddress: parseAddress(env.SNIPER_EVM_WALLET_ADDRESS, 'SNIPER_EVM_WALLET_ADDRESS'),
  };
}
