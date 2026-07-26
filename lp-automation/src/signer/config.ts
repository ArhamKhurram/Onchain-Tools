// Signer configuration + the arm gate.
//
// Split from the signer itself so the parsing is pure and unit-testable, and so
// that `SignerConfig` — the object that gets logged, embedded in status, and
// serialized into the audit trail — provably CANNOT contain key material. The
// private key is read by a separate function that returns it to exactly one
// caller (the client factory), which converts it to an account and drops it.
//
// Nothing in this file ever echoes the value of LP_OPERATOR_PRIVATE_KEY, not
// even in a validation error. "Your key is malformed" is a useful message;
// "your key 0xabc… is malformed" is a key in a log file.

import { config as loadDotenv } from 'dotenv';

import { ROBINHOOD_CHAIN_ID, type Address } from '../types.js';
import type { ArmState } from './types.js';

export class SignerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerConfigError';
  }
}

/** The env var that arms the process. Deliberately not shared with anything else. */
export const ARM_ENV_VAR = 'LP_ARMED';

/**
 * The one string that arms the signer.
 *
 * EXACT MATCH, no trim, no case folding, no truthiness. `1`, `yes`, `on`,
 * `TRUE`, `True`, `" true "` and every other near-miss stay DISARMED. The
 * asymmetry is deliberate: a false negative costs a missed compound, a false
 * positive spends real money. A shell that exports `LP_ARMED=TRUE` because
 * someone shouted it should not move funds.
 */
const ARM_VALUE = 'true';

/**
 * Resolve the arm state from a raw env value. Total function — there is no
 * "invalid" arm state, because refusing to decide would itself be a decision to
 * either stall the pipeline or (worse) fall through to armed.
 */
export function parseArmState(raw: string | undefined | null): ArmState {
  return raw === ARM_VALUE ? 'armed' : 'disarmed';
}

/**
 * Everything the signer needs EXCEPT the key.
 *
 * Safe to `JSON.stringify`, log, and attach to an audit record. Keep it that
 * way: never add a field that holds, wraps, or derives from the private key
 * beyond the public operator address.
 */
export interface SignerConfig {
  readonly rpcUrl: string;
  readonly safeAddress: Address;
  readonly moduleAddress: Address;
  readonly chainId: number;
  readonly armState: ArmState;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function requireAddress(raw: string | undefined, name: string): Address {
  const value = raw?.trim();
  if (!value) throw new SignerConfigError(`${name} is required`);
  if (!ADDRESS.test(value)) {
    throw new SignerConfigError(`${name} is not a 20-byte hex address (got "${value}")`);
  }
  const lowered = value.toLowerCase() as Address;
  if (lowered === ZERO_ADDRESS) throw new SignerConfigError(`${name} must not be the zero address`);
  return lowered;
}

function requireHttpUrl(raw: string | undefined, name: string): string {
  const value = raw?.trim();
  if (!value) throw new SignerConfigError(`${name} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SignerConfigError(`${name} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SignerConfigError(`${name} must be an http(s) endpoint (got ${parsed.protocol})`);
  }
  return value;
}

/** Pure: env record in, validated config out. Never reads `process.env` itself. */
export function parseSignerConfig(env: Record<string, string | undefined>): SignerConfig {
  const rpcUrl = requireHttpUrl(env.LP_RPC_URL, 'LP_RPC_URL');
  const safeAddress = requireAddress(env.LP_SAFE_ADDRESS, 'LP_SAFE_ADDRESS');
  const moduleAddress = requireAddress(env.LP_MODULE_ADDRESS, 'LP_MODULE_ADDRESS');

  // The module rejects `to == safe` on the operator path and refuses to
  // allowlist itself; a config where the two collapse to one address is a
  // misconfiguration that would otherwise only surface as an on-chain revert.
  if (safeAddress === moduleAddress) {
    throw new SignerConfigError('LP_SAFE_ADDRESS and LP_MODULE_ADDRESS must be different addresses');
  }

  return {
    rpcUrl,
    safeAddress,
    moduleAddress,
    // Phase 1 is single-chain by construction (plan §1). Not env-driven: a typo
    // in a chain id is a signed transaction on the wrong network.
    chainId: ROBINHOOD_CHAIN_ID,
    armState: parseArmState(env[ARM_ENV_VAR]),
  };
}

/**
 * Read and shape-check the operator key.
 *
 * Returned as a plain string to a single caller, which immediately derives an
 * account from it and lets it go out of scope. It is never stored on a config
 * object, never returned alongside anything else, and never interpolated into
 * an error. The shape check is the only inspection performed here — validating
 * that it is on the secp256k1 curve is `privateKeyToAccount`'s job.
 */
export function readOperatorPrivateKey(env: Record<string, string | undefined>): `0x${string}` {
  const raw = env.LP_OPERATOR_PRIVATE_KEY?.trim();
  if (!raw) throw new SignerConfigError('LP_OPERATOR_PRIVATE_KEY is required');
  if (!PRIVATE_KEY.test(raw)) {
    // NOTE: the value is deliberately absent from this message. A malformed key
    // is still very often a real key with a typo.
    throw new SignerConfigError(
      'LP_OPERATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string (value withheld)',
    );
  }
  return raw as `0x${string}`;
}

/** Loads `.env` without clobbering injected vars (CLAUDE.md), then parses. */
export function loadSignerConfig(env: NodeJS.ProcessEnv = process.env): SignerConfig {
  loadDotenv({ override: false });
  return parseSignerConfig(env);
}
