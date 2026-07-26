// Pure argument parsing and validation for the deployment scripts.
//
// Everything in this file is a pure function of its inputs. That is deliberate:
// these functions decide what gets deployed and what gets allowlisted, so they
// are the part of the tooling that most needs to be tested, and they cannot be
// tested if they read `process.argv` or `process.env` themselves. The scripts
// pass those in.
//
// Covered by `test/scripts.test.ts`.

import { EXPECTED_CHAIN_ID, MAX_DAILY_VALUE_CAP } from './constants.js';

/** Raised for any bad input. Always fatal — no script continues past one. */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export interface ParsedArgs {
  /** `--flag value` and `--flag=value` pairs. Values are raw strings. */
  readonly values: ReadonlyMap<string, string>;
  /** `--flag` with no value. */
  readonly booleans: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

const BOOLEAN_FLAGS = new Set([
  'broadcast',
  'help',
  'h',
  'yes',
  'json',
  'revoke',
  'no-color',
]);

/**
 * Minimal flag parser. Recognises `--flag`, `--flag value`, `--flag=value`.
 *
 * Only the flags in `BOOLEAN_FLAGS` may appear without a value; anything else
 * bare is an error rather than a silently-empty string. `--broadcast` being
 * mistyped as `--broadcast=` and quietly meaning "no" is exactly the class of
 * bug that makes a safety flag decorative.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body.length === 0) throw new ArgError('Bare `--` is not a valid flag');

    const eq = body.indexOf('=');
    if (eq >= 0) {
      const name = body.slice(0, eq);
      const value = body.slice(eq + 1);
      if (value === '') throw new ArgError(`--${name} was given an empty value`);
      values.set(name, value);
      continue;
    }

    if (BOOLEAN_FLAGS.has(body)) {
      booleans.add(body);
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new ArgError(`--${body} requires a value`);
    }
    values.set(body, next);
    i += 1;
  }

  return { values, booleans, positionals };
}

/**
 * Refuse to run if anything that looks like a private key was passed on the
 * command line.
 *
 * A key on argv ends up in shell history, in `ps` output, and in any process
 * listing on the box. These scripts read keys from the environment only, and
 * this check makes the rule enforced rather than documented. The offending
 * value is NEVER echoed back — only its position.
 */
export function findPrivateKeyLikeArgs(argv: readonly string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    // Check both `--key 0xabc…` (the token itself) and `--key=0xabc…`.
    const candidate = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(candidate)) hits.push(i);
  }
  return hits;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Validate and lowercase-normalize an address.
 *
 * Deliberately does NOT accept a bare 40-hex string without `0x`, and does not
 * "helpfully" trim internal whitespace: an address that arrives in an odd shape
 * is an address that came from somewhere unexpected.
 */
export function requireAddress(raw: string | undefined, label: string): `0x${string}` {
  if (raw === undefined || raw.trim() === '') {
    throw new ArgError(`${label} is required but was not set`);
  }
  const value = raw.trim();
  if (!ADDRESS_RE.test(value)) {
    throw new ArgError(`${label} is not a 20-byte 0x address: ${value}`);
  }
  if (value.toLowerCase() === ZERO_ADDRESS) {
    throw new ArgError(`${label} is the zero address`);
  }
  return value.toLowerCase() as `0x${string}`;
}

/** True when two addresses refer to the same account, ignoring checksum casing. */
export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Parse a native-value amount given as either wei or whole ETH.
 *
 * Exactly one of the two must be supplied. Accepting both and picking a winner
 * would let a stale `--daily-cap-eth` silently override a fresh
 * `--daily-cap-wei`, and the failure mode of that is "the cap is 1000x what you
 * thought".
 */
export function parseAmount(
  input: { wei?: string | undefined; eth?: string | undefined },
  label: string,
): bigint {
  const hasWei = input.wei !== undefined && input.wei.trim() !== '';
  const hasEth = input.eth !== undefined && input.eth.trim() !== '';

  if (hasWei && hasEth) {
    throw new ArgError(`${label}: give either wei or ether, not both (got both)`);
  }
  if (!hasWei && !hasEth) {
    throw new ArgError(`${label} is required (supply it in wei or in ether)`);
  }

  if (hasWei) return parseWei(input.wei!.trim(), label);
  return parseEther18(input.eth!.trim(), label);
}

function parseWei(raw: string, label: string): bigint {
  const cleaned = raw.replace(/_/g, '');
  if (!/^\d+$/.test(cleaned)) {
    throw new ArgError(`${label}: "${raw}" is not a whole number of wei`);
  }
  return BigInt(cleaned);
}

/**
 * Decimal ether -> wei, exactly, without floating point.
 *
 * `Number('0.1') * 1e18` is 100000000000000000 only by luck; for other values it
 * is off by hundreds of wei. A cap is a security parameter, so it is parsed as
 * text.
 */
function parseEther18(raw: string, label: string): bigint {
  const cleaned = raw.replace(/_/g, '');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) throw new ArgError(`${label}: "${raw}" is not a decimal ether amount`);
  const whole = match[1]!;
  const frac = match[2] ?? '';
  if (frac.length > 18) {
    throw new ArgError(`${label}: "${raw}" has more than 18 decimal places`);
  }
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0') || '0');
}

export interface CapCheck {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Sanity-check the two constructor caps before anyone pays gas for them.
 *
 * `dailyValueCap > type(uint192).max` is a hard revert in the constructor; the
 * rest are configurations the contract accepts but a human almost certainly did
 * not mean.
 */
export function checkCaps(maxValuePerTx: bigint, dailyValueCap: bigint): CapCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (maxValuePerTx < 0n) errors.push('maxValuePerTx is negative');
  if (dailyValueCap < 0n) errors.push('dailyValueCap is negative');
  if (dailyValueCap > MAX_DAILY_VALUE_CAP) {
    errors.push(
      `dailyValueCap ${dailyValueCap} exceeds MAX_DAILY_VALUE_CAP ${MAX_DAILY_VALUE_CAP} — the constructor will revert`,
    );
  }

  if (maxValuePerTx > dailyValueCap) {
    warnings.push(
      `maxValuePerTx (${maxValuePerTx} wei) is larger than dailyValueCap (${dailyValueCap} wei) — ` +
        'the per-transaction cap is unreachable, the daily cap binds first. Probably a units mistake.',
    );
  }
  if (maxValuePerTx === 0n) {
    warnings.push(
      'maxValuePerTx is 0 — every value-bearing execution will revert. Correct if you only ever ' +
        'expect ERC-20 flows (which carry no native value); wrong if you plan native-token zap-ins.',
    );
  }
  if (dailyValueCap === 0n) {
    warnings.push('dailyValueCap is 0 — no native value can ever leave the Safe through this module.');
  }
  if (dailyValueCap > 10n ** 18n) {
    warnings.push(
      `dailyValueCap is ${formatEther(dailyValueCap)} ETH. Remember the fixed UTC-day bucket: up to ` +
        `${formatEther(dailyValueCap * 2n)} ETH can leave in one burst straddling midnight UTC ` +
        '(contracts/README.md §3). Size it so losing 2x is survivable.',
    );
  }

  return { errors, warnings };
}

/** wei -> a human-readable ether string with no trailing-zero noise. Pure. */
export function formatEther(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  const body = frac === '' ? whole.toString() : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
}

/**
 * Decide whether a chain id is acceptable.
 *
 * Refusing by default is the whole point: deploying to the wrong chain is
 * silent, irreversible and expensive. `allowChainId` must be passed explicitly
 * by a human who typed the number they meant.
 */
export function checkChainId(
  observed: number,
  allowChainId?: number | undefined,
): { ok: boolean; reason?: string } {
  if (observed === EXPECTED_CHAIN_ID) return { ok: true };
  if (allowChainId !== undefined && observed === allowChainId) {
    return { ok: true, reason: `chain ${observed} accepted only because --allow-chain ${allowChainId} was passed` };
  }
  return {
    ok: false,
    reason:
      `RPC reports chain id ${observed}, expected ${EXPECTED_CHAIN_ID} (Robinhood Chain). ` +
      `Refusing to continue. If this is genuinely intended, pass --allow-chain ${observed}.`,
  };
}

/** Parse an integer flag (chain id, block number) without Number() surprises. */
export function parseInteger(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const cleaned = raw.trim().replace(/_/g, '');
  if (!/^\d+$/.test(cleaned)) throw new ArgError(`${label}: "${raw}" is not a non-negative integer`);
  const parsed = Number(cleaned);
  if (!Number.isSafeInteger(parsed)) throw new ArgError(`${label}: "${raw}" is out of safe integer range`);
  return parsed;
}

/** Parse a block number flag, which may also be the literal `earliest`. */
export function parseFromBlock(raw: string | undefined): bigint | 'earliest' | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (value === 'earliest' || value === '0') return 'earliest';
  const cleaned = value.replace(/_/g, '');
  if (!/^\d+$/.test(cleaned)) throw new ArgError(`--from-block: "${raw}" is not a block number`);
  return BigInt(cleaned);
}

/**
 * Validate an RPC URL.
 *
 * Plain `http://` to a remote host means the RPC responses these scripts base
 * their PASS/FAIL verdicts on are attacker-modifiable in transit. Localhost is
 * exempted because a local node over loopback is a normal setup.
 */
export function checkRpcUrl(raw: string | undefined): { url: string; warnings: string[] } {
  if (raw === undefined || raw.trim() === '') {
    throw new ArgError('LP_RPC_URL is not set (and no --rpc-url was given)');
  }
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ArgError(`LP_RPC_URL is not a valid URL: ${url}`);
  }
  const warnings: string[] = [];
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    throw new ArgError('LP_RPC_URL must be an HTTP(S) endpoint, not a WebSocket one (that is LP_RPC_WS_URL)');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ArgError(`LP_RPC_URL must be http(s), got ${parsed.protocol}`);
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !isLocal) {
    warnings.push(
      `RPC is plain http:// to a remote host (${parsed.hostname}). Every verdict below is only as ` +
        'trustworthy as that connection. Use https://.',
    );
  }
  return { url, warnings };
}

/**
 * Render an RPC URL safe to print.
 *
 * Alchemy and QuickNode — the two providers plan §3 names — both put the API key
 * in the URL path. These scripts print their configuration back at the user, and
 * that output gets pasted into issues and chat windows, so the path, query and
 * any userinfo are stripped. Only the origin survives, which is all a human
 * needs to answer "am I pointed at the right provider?".
 */
export function redactRpcUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '<unparseable URL, not printed>';
  }
  const hasSecretPath = parsed.pathname.replace(/\/+$/, '') !== '' || parsed.search !== '' || parsed.username !== '';
  return hasSecretPath ? `${parsed.protocol}//${parsed.host}/<redacted>` : `${parsed.protocol}//${parsed.host}`;
}
