// Process-level configuration.
//
// The RPC watch layer already owns its own env parsing (`ingest/rpc/config.ts`)
// and this module REUSES it rather than re-reading `LP_RPC_*` — two parsers for
// the same variables is how a process ends up watching one endpoint and calling
// another. Everything here is the configuration the *process* needs on top of
// that: which Safe, which policy file, how often to poll, and the bounds the
// calldata validator enforces.
//
// Two rules, matching the rest of the workspace:
//
//   1. `parseConfig` is pure — env record in, config out, `ConfigError` on any
//      problem. `loadConfig` is the thin impure wrapper that reads `.env` with
//      `override: false` first, so a platform-injected variable always beats a
//      stale local file (CLAUDE.md — "never clobber injected secrets").
//   2. Every error names the offending variable. A signer process that refuses
//      to start must say which line of the deployment config to fix; "invalid
//      configuration" costs someone an hour.
//
// Defaults fail CLOSED. `maxValueWei` defaults to 0 (no native value may leave
// without an explicit opt-in) and the policy file is optional only because its
// absence means DEFAULT_POLICY, whose allowlist is empty and which therefore
// authorizes nothing.

import { config as loadDotenv } from 'dotenv';
import { parseRpcConfig, RpcConfigError, type RpcConfig } from './ingest/rpc/config.js';
import { CHAIN_IDS, type Address, type ChainSlug } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LpAutomationConfig {
  rpc: RpcConfig;
  chain: ChainSlug;
  chainId: number;
  /** The Safe that holds the funds. Krystal builds every transaction FOR this. */
  safeAddress: Address;
  /** Krystal platform key. `uniswapv3` on Robinhood Chain (plan §3). */
  platform: string;
  krystalBaseUrl: string | undefined;
  /** Append-only JSONL audit log (plan §10 step 6). */
  auditLogPath: string;
  /** JSON policy file, or null to run on `DEFAULT_POLICY` (which does nothing). */
  policyFilePath: string | null;
  /** OCT account whose dashboard policy this worker follows (Supabase source). */
  policyUserId: string;
  positionPollIntervalMs: number;
  commandPollIntervalMs: number;
  calldataMaxAgeMs: number;
  /** Slippage FRACTIONS — 0.005 is 0.5%. See `calldata/lpTxn.ts`. */
  swapSlippage: number;
  liquiditySlippage: number;
  /** Hard ceiling on native value in one transaction, in wei. */
  maxValueWei: bigint;
  /** Operator's per-transaction gas estimate in USD; null means unknown. */
  gasCostUsd: number | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const DEFAULTS = {
  auditLogPath: './data/audit.jsonl',
  positionPollIntervalMs: 60_000,
  // Manual actions are a human waiting on a click; this reads only our own
  // Supabase table (not Krystal), so the slow-lane rate-limit reasoning does
  // not apply and it can be tight.
  commandPollIntervalMs: 1_000,
  calldataMaxAgeMs: 30_000,
  swapSlippage: 0.005,
  liquiditySlippage: 0.005,
  platform: 'uniswapv3',
} as const;

/** Krystal rejects slippage >= 1 and 0.05 is already 5%; see `lpTxn.ts`. */
const MAX_SLIPPAGE = 0.05;

function requireAddress(raw: string | undefined, name: string): Address {
  const value = raw?.trim();
  if (!value) throw new ConfigError(`${name} is required (the Safe that holds the LP positions)`);
  if (!ADDRESS.test(value)) {
    throw new ConfigError(`${name} must be a 0x-prefixed 20-byte address (got "${value}")`);
  }
  return value.toLowerCase() as Address;
}

function readNumber(
  raw: string | undefined,
  name: string,
  fallback: number,
  bounds: { min: number; max?: number },
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a finite number (got "${value}")`);
  }
  if (parsed < bounds.min) {
    throw new ConfigError(`${name} must be at least ${bounds.min} (got ${parsed})`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new ConfigError(`${name} must be at most ${bounds.max} (got ${parsed})`);
  }
  return parsed;
}

function readSlippage(raw: string | undefined, name: string, fallback: number): number {
  const value = readNumber(raw, name, fallback, { min: 0, max: MAX_SLIPPAGE });
  if (value <= 0) {
    throw new ConfigError(
      `${name} must be greater than 0. It is a FRACTION, not a percentage: 0.005 means 0.5%.`,
    );
  }
  return value;
}

/** Pure: env record in, validated config out. Never reads `process.env` itself. */
export function parseConfig(env: Record<string, string | undefined>): LpAutomationConfig {
  // Delegate, then re-label: the RPC parser's messages already name their own
  // variables, and rewriting them would lose that.
  let rpc: RpcConfig;
  try {
    rpc = parseRpcConfig(env);
  } catch (error) {
    if (error instanceof RpcConfigError) throw new ConfigError(error.message);
    throw error;
  }

  const chainRaw = env.LP_CHAIN?.trim().toLowerCase();
  if (chainRaw !== undefined && chainRaw !== '' && chainRaw !== 'robinhood') {
    throw new ConfigError(`LP_CHAIN must be 'robinhood' (phase 1 supports no other chain), got "${chainRaw}"`);
  }
  const chain: ChainSlug = 'robinhood';

  const maxValueRaw = env.LP_MAX_TX_VALUE_WEI?.trim();
  let maxValueWei = 0n;
  if (maxValueRaw) {
    try {
      maxValueWei = BigInt(maxValueRaw);
    } catch {
      throw new ConfigError(`LP_MAX_TX_VALUE_WEI must be an integer number of wei (got "${maxValueRaw}")`);
    }
    if (maxValueWei < 0n) throw new ConfigError('LP_MAX_TX_VALUE_WEI must not be negative');
  }

  const gasRaw = env.LP_GAS_COST_USD?.trim();
  const gasCostUsd =
    gasRaw === undefined || gasRaw === ''
      ? null
      : readNumber(gasRaw, 'LP_GAS_COST_USD', 0, { min: 0 });

  const policyFileRaw = env.LP_POLICY_FILE?.trim();

  return {
    rpc,
    chain,
    chainId: CHAIN_IDS[chain],
    safeAddress: requireAddress(env.LP_SAFE_ADDRESS, 'LP_SAFE_ADDRESS'),
    platform: env.LP_KRYSTAL_PLATFORM?.trim() || DEFAULTS.platform,
    krystalBaseUrl: env.KRYSTAL_API_BASE?.trim() || undefined,
    auditLogPath: env.LP_AUDIT_LOG_PATH?.trim() || DEFAULTS.auditLogPath,
    policyFilePath: policyFileRaw ? policyFileRaw : null,
    // Which OCT account's dashboard-authored policy this worker follows. Only
    // needed when SUPABASE_* are set; the policy table is per-user.
    policyUserId: env.LP_POLICY_USER_ID?.trim() ?? '',
    positionPollIntervalMs: readNumber(
      env.LP_POSITION_POLL_INTERVAL_MS,
      'LP_POSITION_POLL_INTERVAL_MS',
      DEFAULTS.positionPollIntervalMs,
      // A floor, not a preference: Krystal showed no rate limiting when sampled
      // (plan §11 item 2), but hammering a third-party API we do not pay for is
      // how that changes.
      { min: 5_000 },
    ),
    commandPollIntervalMs: readNumber(
      env.LP_COMMAND_POLL_INTERVAL_MS,
      'LP_COMMAND_POLL_INTERVAL_MS',
      DEFAULTS.commandPollIntervalMs,
      // 250ms floor: this only polls our own DB, but a runaway loop below that
      // is pointless churn given the pipeline behind it takes seconds anyway.
      { min: 250 },
    ),
    calldataMaxAgeMs: readNumber(
      env.LP_CALLDATA_MAX_AGE_MS,
      'LP_CALLDATA_MAX_AGE_MS',
      DEFAULTS.calldataMaxAgeMs,
      { min: 1_000 },
    ),
    swapSlippage: readSlippage(env.LP_SWAP_SLIPPAGE, 'LP_SWAP_SLIPPAGE', DEFAULTS.swapSlippage),
    liquiditySlippage: readSlippage(
      env.LP_LIQUIDITY_SLIPPAGE,
      'LP_LIQUIDITY_SLIPPAGE',
      DEFAULTS.liquiditySlippage,
    ),
    maxValueWei,
    gasCostUsd,
  };
}

/** Loads `.env` (without clobbering injected vars) and parses the process config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LpAutomationConfig {
  loadDotenv({ override: false });
  return parseConfig(env);
}
