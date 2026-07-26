// Environment loading for the deployment scripts.
//
// ============================================================================
// KEY HANDLING RULE — the only rule in this file that matters.
// ============================================================================
// A private key is read from `process.env` and immediately turned into a viem
// Account. The raw string is never returned to a caller, never stored in an
// object that gets logged, never interpolated into a message, and never written
// to disk. `loadOperatorAccount` returns an Account whose `.address` is the only
// thing any script prints.
//
// There is no `--private-key` flag anywhere in this tooling, and `args.ts`
// actively refuses to run if a key-shaped value appears on argv, because argv
// is visible in shell history and in `ps`.
// ============================================================================

import { config as loadDotenv } from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgError, requireAddress } from './args.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `lp-automation/` — scripts/lib -> scripts -> lp-automation */
export const WORKSPACE_ROOT = resolve(HERE, '..', '..');

let loaded = false;

/**
 * Load `lp-automation/.env` with `override: false`.
 *
 * Same rule as `backend/src/index.ts`: a value already present in the real
 * environment always wins. On a deployment box the secrets are injected, and a
 * stale checked-out `.env` silently overriding them is how you deploy against
 * the wrong Safe.
 */
export function loadEnv(): void {
  if (loaded) return;
  loadDotenv({ path: resolve(WORKSPACE_ROOT, '.env'), override: false });
  loaded = true;
}

export function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function requireEnv(name: string, why: string): string {
  const value = optionalEnv(name);
  if (value === undefined) throw new ArgError(`${name} is not set. ${why}`);
  return value;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Turn a private key in the environment into an Account, without the key ever
 * leaving this function.
 *
 * The error messages here are written carefully: they say what is wrong with
 * the key's *shape*, never what the key contains. "Invalid key: 0x1234..." in a
 * CI log is a leaked key.
 */
export function loadAccountFromEnv(envName: string): PrivateKeyAccount {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') {
    throw new ArgError(
      `${envName} is not set. This script needs a hot key to sign with; it is read from the ` +
        'environment only and is never accepted as a command-line flag.',
    );
  }
  const key = raw.trim();
  if (!PRIVATE_KEY_RE.test(key)) {
    throw new ArgError(
      `${envName} is not a 0x-prefixed 32-byte hex private key (expected 66 characters, got ` +
        `${key.length}). The value itself is deliberately not echoed.`,
    );
  }
  try {
    return privateKeyToAccount(key as `0x${string}`);
  } catch {
    throw new ArgError(`${envName} is not a valid secp256k1 private key. The value is deliberately not echoed.`);
  }
}

/**
 * Resolve the operator ADDRESS without needing the operator key.
 *
 * Read-only scripts (`preflight`, `verifySetup`) must be runnable by someone
 * auditing a setup who has no business holding the hot key — including on a
 * machine where the key deliberately does not exist. So `LP_OPERATOR_ADDRESS`
 * is honoured first and the key is only touched as a fallback.
 */
export function resolveOperatorAddress(explicit?: string): {
  address: `0x${string}`;
  source: 'flag' | 'LP_OPERATOR_ADDRESS' | 'LP_OPERATOR_PRIVATE_KEY';
} {
  if (explicit !== undefined && explicit.trim() !== '') {
    return { address: requireAddress(explicit, '--operator'), source: 'flag' };
  }
  const fromEnv = optionalEnv('LP_OPERATOR_ADDRESS');
  if (fromEnv !== undefined) {
    return { address: requireAddress(fromEnv, 'LP_OPERATOR_ADDRESS'), source: 'LP_OPERATOR_ADDRESS' };
  }
  if (optionalEnv('LP_OPERATOR_PRIVATE_KEY') !== undefined) {
    const account = loadAccountFromEnv('LP_OPERATOR_PRIVATE_KEY');
    return { address: account.address.toLowerCase() as `0x${string}`, source: 'LP_OPERATOR_PRIVATE_KEY' };
  }
  throw new ArgError(
    'Could not determine the operator address. Set LP_OPERATOR_ADDRESS (preferred for read-only ' +
      'scripts — it needs no key present), or LP_OPERATOR_PRIVATE_KEY, or pass --operator 0x...',
  );
}
