// Tests for the pure logic behind the deployment scripts.
//
// Everything here is a function that decides what gets deployed, what gets
// allowlisted, or whether a broadcast is permitted. The scripts themselves are
// thin shells around these — the shells touch a chain and are verified by
// running them against the real one, but the decisions are verified here.
//
// Two of these tests are load-bearing beyond ordinary coverage:
//
//   * "matches the off-chain calldata validator" — asserts the on-chain
//     allowlist this tooling seeds is the same set the `src/calldata/` validator
//     enforces. If those drift, the runner would build calldata the module
//     rejects, or worse, the module would allow a destination the validator no
//     longer trusts.
//
//   * the `classifyAllowlist` reverse-direction tests — "is anything ELSE
//     allowlisted" is the check that finds a compromise. A missing-entry-only
//     audit passes on a compromised setup.

import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeFunctionData } from 'viem';

import { MODULE_ABI, SAFE_ABI } from '../scripts/lib/abi.js';
import {
  ArgError,
  checkCaps,
  checkChainId,
  checkRpcUrl,
  findPrivateKeyLikeArgs,
  formatEther,
  parseAmount,
  parseArgs,
  parseFromBlock,
  parseInteger,
  redactRpcUrl,
  requireAddress,
  sameAddress,
} from '../scripts/lib/args.js';
import { extractArtifact } from '../scripts/lib/artifact.js';
import { checkBroadcastFlags } from '../scripts/lib/confirm.js';
import {
  EXPECTED_CHAIN_ID,
  MAX_DAILY_VALUE_CAP,
  REFERENCE_CONTRACTS,
  ROBINHOOD_ALLOWLIST,
  SAFE_DEPLOYMENTS,
} from '../scripts/lib/constants.js';
import {
  buildAllowlistPlan,
  buildDisableModulePayload,
  buildEnableModulePayload,
  buildExpectedState,
  buildSetPausedPayload,
  classifyAllowlist,
  renderPayload,
  selectorKey,
} from '../scripts/lib/plan.js';
import { renderChecks, renderVerdict, tally, wrap, type CheckResult } from '../scripts/lib/report.js';
import {
  KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3,
  OBSERVED_SELECTORS,
  ROBINHOOD_UNISWAP_V3_TARGETS,
} from '../src/calldata/validate.js';
import { ROBINHOOD_CHAIN_ID } from '../src/types.js';

const MODULE = '0x1111111111111111111111111111111111111111' as const;
const SAFE = '0x2222222222222222222222222222222222222222' as const;
const OPERATOR = '0x3333333333333333333333333333333333333333' as const;

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('reads --flag value and --flag=value identically', () => {
    const a = parseArgs(['--safe', SAFE]);
    const b = parseArgs([`--safe=${SAFE}`]);
    expect(a.values.get('safe')).toBe(SAFE);
    expect(b.values.get('safe')).toBe(SAFE);
  });

  it('treats --broadcast as a boolean', () => {
    const parsed = parseArgs(['--broadcast']);
    expect(parsed.booleans.has('broadcast')).toBe(true);
    expect(parsed.values.has('broadcast')).toBe(false);
  });

  it('rejects a value-taking flag with no value instead of defaulting it to empty', () => {
    // `--safe --broadcast` silently meaning safe="" is how a safety flag turns
    // into a no-op.
    expect(() => parseArgs(['--safe', '--broadcast'])).toThrow(ArgError);
    expect(() => parseArgs(['--safe'])).toThrow(ArgError);
  });

  it('rejects --flag= with an empty value', () => {
    expect(() => parseArgs(['--safe='])).toThrow(ArgError);
  });

  it('collects positionals', () => {
    expect(parseArgs(['foo', '--broadcast', 'bar']).positionals).toEqual(['foo', 'bar']);
  });
});

// ---------------------------------------------------------------------------
// key hygiene
// ---------------------------------------------------------------------------

describe('findPrivateKeyLikeArgs', () => {
  const KEY_SHAPED = `0x${'a'.repeat(64)}`;

  it('flags a 0x-prefixed 32-byte hex value passed as its own token', () => {
    expect(findPrivateKeyLikeArgs(['--rpc-url', 'https://x', KEY_SHAPED])).toEqual([2]);
  });

  it('flags it inside --flag=value form too', () => {
    expect(findPrivateKeyLikeArgs([`--key=${KEY_SHAPED}`])).toEqual([0]);
  });

  it('flags an unprefixed 64-hex value', () => {
    expect(findPrivateKeyLikeArgs(['a'.repeat(64)])).toEqual([0]);
  });

  it('does not flag an ordinary address or a tx hash flag name', () => {
    expect(findPrivateKeyLikeArgs(['--safe', SAFE, '--broadcast'])).toEqual([]);
  });

  it('never returns the offending value, only its index', () => {
    const hits = findPrivateKeyLikeArgs([KEY_SHAPED]);
    expect(hits).toEqual([0]);
    expect(JSON.stringify(hits)).not.toContain('aaaa');
  });
});

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

describe('requireAddress', () => {
  it('lowercases a checksummed address', () => {
    expect(requireAddress(SAFE_DEPLOYMENTS.v1_4_1.singleton, 'x')).toBe(
      SAFE_DEPLOYMENTS.v1_4_1.singleton.toLowerCase(),
    );
  });

  it('rejects the zero address', () => {
    expect(() => requireAddress(`0x${'0'.repeat(40)}`, 'safe')).toThrow(/zero address/);
  });

  it('rejects a short address, a long one, and a non-hex one', () => {
    expect(() => requireAddress('0x1234', 'safe')).toThrow(ArgError);
    expect(() => requireAddress(`0x${'1'.repeat(41)}`, 'safe')).toThrow(ArgError);
    expect(() => requireAddress(`0x${'z'.repeat(40)}`, 'safe')).toThrow(ArgError);
  });

  it('rejects an address with no 0x prefix rather than adding one', () => {
    expect(() => requireAddress('1'.repeat(40), 'safe')).toThrow(ArgError);
  });

  it('names the field in the error so the human knows which one is wrong', () => {
    expect(() => requireAddress(undefined, 'LP_SAFE_ADDRESS')).toThrow(/LP_SAFE_ADDRESS/);
  });
});

describe('sameAddress', () => {
  it('ignores checksum casing', () => {
    expect(sameAddress('0xAbCd'.padEnd(42, '0'), '0xabcd'.padEnd(42, '0'))).toBe(true);
  });
  it('is false for undefined on either side', () => {
    expect(sameAddress(undefined, SAFE)).toBe(false);
    expect(sameAddress(SAFE, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// amounts
// ---------------------------------------------------------------------------

describe('parseAmount', () => {
  it('parses whole ether exactly', () => {
    expect(parseAmount({ eth: '1' }, 'cap')).toBe(10n ** 18n);
  });

  it('parses fractional ether exactly, without floating point', () => {
    // 0.1 * 1e18 in float is not reliably 1e17; this is why it is parsed as text.
    expect(parseAmount({ eth: '0.1' }, 'cap')).toBe(100_000_000_000_000_000n);
    expect(parseAmount({ eth: '0.000000000000000001' }, 'cap')).toBe(1n);
    expect(parseAmount({ eth: '1.005' }, 'cap')).toBe(1_005_000_000_000_000_000n);
  });

  it('parses wei', () => {
    expect(parseAmount({ wei: '12345' }, 'cap')).toBe(12345n);
  });

  it('allows underscores as digit separators', () => {
    expect(parseAmount({ wei: '1_000_000' }, 'cap')).toBe(1_000_000n);
  });

  it('refuses both units at once rather than picking a winner', () => {
    // Picking a winner is how a stale --cap-eth silently overrides a fresh
    // --cap-wei and the cap ends up 1000x what was intended.
    expect(() => parseAmount({ wei: '1', eth: '1' }, 'cap')).toThrow(/not both/);
  });

  it('refuses neither', () => {
    expect(() => parseAmount({}, 'cap')).toThrow(/required/);
  });

  it('rejects more than 18 decimal places instead of truncating', () => {
    expect(() => parseAmount({ eth: '0.0000000000000000001' }, 'cap')).toThrow(/18 decimal/);
  });

  it('rejects negative, scientific and hex forms', () => {
    expect(() => parseAmount({ eth: '-1' }, 'cap')).toThrow(ArgError);
    expect(() => parseAmount({ eth: '1e18' }, 'cap')).toThrow(ArgError);
    expect(() => parseAmount({ wei: '0x10' }, 'cap')).toThrow(ArgError);
  });
});

describe('formatEther', () => {
  it('round-trips with parseAmount', () => {
    for (const value of ['0', '1', '0.1', '12.34567', '0.000000000000000001']) {
      const wei = parseAmount({ eth: value }, 'x');
      expect(parseAmount({ eth: formatEther(wei) }, 'x')).toBe(wei);
    }
  });

  it('drops trailing zeros but keeps the integer part', () => {
    expect(formatEther(10n ** 18n)).toBe('1');
    expect(formatEther(1n)).toBe('0.000000000000000001');
    expect(formatEther(0n)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// cap sanity
// ---------------------------------------------------------------------------

describe('checkCaps', () => {
  it('accepts an ordinary configuration', () => {
    const result = checkCaps(parseAmount({ eth: '0.01' }, 'a'), parseAmount({ eth: '0.05' }, 'b'));
    expect(result.errors).toEqual([]);
  });

  it('errors when dailyValueCap exceeds the uint192 bound the constructor enforces', () => {
    const result = checkCaps(0n, MAX_DAILY_VALUE_CAP + 1n);
    expect(result.errors.join(' ')).toMatch(/MAX_DAILY_VALUE_CAP/);
  });

  it('accepts exactly the bound', () => {
    expect(checkCaps(0n, MAX_DAILY_VALUE_CAP).errors).toEqual([]);
  });

  it('warns when the per-tx cap exceeds the daily cap (almost always a units mistake)', () => {
    const result = checkCaps(10n ** 18n, 10n ** 15n);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/unreachable/);
  });

  it('warns about the 2x midnight-UTC burst for a non-trivial daily cap', () => {
    const result = checkCaps(10n ** 18n, 5n * 10n ** 18n);
    expect(result.warnings.join(' ')).toMatch(/midnight UTC/);
  });

  it('warns rather than errors on zero caps — a legitimate ERC-20-only setup', () => {
    const result = checkCaps(0n, 0n);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// chain id
// ---------------------------------------------------------------------------

describe('checkChainId', () => {
  it('accepts 4663', () => {
    expect(checkChainId(EXPECTED_CHAIN_ID).ok).toBe(true);
    expect(EXPECTED_CHAIN_ID).toBe(ROBINHOOD_CHAIN_ID);
    expect(EXPECTED_CHAIN_ID).toBe(4663);
  });

  it('refuses every other chain by default, and names the flag that would allow it', () => {
    for (const wrong of [1, 8453, 4664, 0]) {
      const verdict = checkChainId(wrong);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/--allow-chain/);
    }
  });

  it('accepts an override only for the exact id that was named', () => {
    expect(checkChainId(8453, 8453).ok).toBe(true);
    expect(checkChainId(8453, 1).ok).toBe(false);
  });

  it('still says the override was used, so it cannot pass silently', () => {
    expect(checkChainId(8453, 8453).reason).toMatch(/only because/);
  });
});

// ---------------------------------------------------------------------------
// RPC url
// ---------------------------------------------------------------------------

describe('checkRpcUrl', () => {
  it('accepts https', () => {
    expect(checkRpcUrl('https://rpc.mainnet.chain.robinhood.com').warnings).toEqual([]);
  });

  it('warns about plain http to a remote host', () => {
    expect(checkRpcUrl('http://example.com').warnings.join(' ')).toMatch(/plain http/);
  });

  it('does not warn about http on localhost', () => {
    expect(checkRpcUrl('http://localhost:8545').warnings).toEqual([]);
  });

  it('rejects a websocket url with a message pointing at the right variable', () => {
    expect(() => checkRpcUrl('wss://example.com')).toThrow(/LP_RPC_WS_URL/);
  });

  it('rejects empty and malformed urls', () => {
    expect(() => checkRpcUrl(undefined)).toThrow(ArgError);
    expect(() => checkRpcUrl('   ')).toThrow(ArgError);
    expect(() => checkRpcUrl('not a url')).toThrow(ArgError);
  });
});

describe('redactRpcUrl', () => {
  it('strips the path, where Alchemy and QuickNode put the API key', () => {
    const redacted = redactRpcUrl('https://rh-mainnet.g.alchemy.com/v2/SUPER_SECRET_KEY');
    expect(redacted).not.toContain('SUPER_SECRET_KEY');
    expect(redacted).toBe('https://rh-mainnet.g.alchemy.com/<redacted>');
  });

  it('strips query strings and userinfo too', () => {
    expect(redactRpcUrl('https://node.example.com?apikey=abc')).not.toContain('abc');
    expect(redactRpcUrl('https://user:pass@node.example.com')).not.toContain('pass');
  });

  it('leaves a bare origin readable, so the human can still tell what they are pointed at', () => {
    expect(redactRpcUrl('https://rpc.mainnet.chain.robinhood.com')).toBe('https://rpc.mainnet.chain.robinhood.com');
  });

  it('never throws on garbage input', () => {
    expect(redactRpcUrl('::::')).toContain('not printed');
  });
});

// ---------------------------------------------------------------------------
// misc parsers
// ---------------------------------------------------------------------------

describe('parseInteger / parseFromBlock', () => {
  it('returns undefined for absent values rather than a fake 0', () => {
    expect(parseInteger(undefined, 'x')).toBeUndefined();
    expect(parseFromBlock(undefined)).toBeUndefined();
  });

  it('rejects non-integers', () => {
    expect(() => parseInteger('4663.5', 'x')).toThrow(ArgError);
    expect(() => parseInteger('-1', 'x')).toThrow(ArgError);
  });

  it('maps block 0 to `earliest`', () => {
    expect(parseFromBlock('0')).toBe('earliest');
    expect(parseFromBlock('earliest')).toBe('earliest');
    expect(parseFromBlock('12345')).toBe(12345n);
  });
});

// ---------------------------------------------------------------------------
// broadcast gating
// ---------------------------------------------------------------------------

describe('checkBroadcastFlags', () => {
  it('defaults to dry run when --broadcast is absent', () => {
    const gate = checkBroadcastFlags({ broadcast: false, yes: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/DRY RUN/);
  });

  it('never lets --yes substitute for the typed confirmation', () => {
    expect(checkBroadcastFlags({ broadcast: true, yes: true }).allowed).toBe(false);
    expect(checkBroadcastFlags({ broadcast: false, yes: true }).allowed).toBe(false);
  });

  it('allows only --broadcast alone, and still says a typed confirmation follows', () => {
    const gate = checkBroadcastFlags({ broadcast: true, yes: false });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toMatch(/typed confirmation/);
  });
});

// ---------------------------------------------------------------------------
// the allowlist constant
// ---------------------------------------------------------------------------

describe('ROBINHOOD_ALLOWLIST', () => {
  it('includes every Krystal target from the off-chain calldata validator', () => {
    const scriptTargets = ROBINHOOD_ALLOWLIST.map((d) => d.address.toLowerCase());
    for (const target of ROBINHOOD_UNISWAP_V3_TARGETS) {
      expect(scriptTargets).toContain(target.toLowerCase());
    }
  });

  it('carries exactly the three verified selectors, on the right destinations', () => {
    const v3utils = ROBINHOOD_ALLOWLIST.find((d) =>
      sameAddress(d.address, KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.v3utils),
    );
    const positionManager = ROBINHOOD_ALLOWLIST.find((d) =>
      sameAddress(d.address, KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.positionManager),
    );

    expect(v3utils?.selectors).toEqual([OBSERVED_SELECTORS.swap_and_mint, OBSERVED_SELECTORS.swap_and_increase]);
    expect(positionManager?.selectors).toEqual([OBSERVED_SELECTORS.compound]);

    // The asymmetry the plan calls out: one selector covers three operations.
    expect(OBSERVED_SELECTORS.compound).toBe(OBSERVED_SELECTORS.adjust_range);
    expect(OBSERVED_SELECTORS.compound).toBe(OBSERVED_SELECTORS.withdraw_and_swap);
  });

  it('pins the exact verified addresses (a wrong one here is unrecoverable)', () => {
    expect(KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.v3utils).toBe('0xb4acbc082b5e7ded571c98ee4257778a9d784b36');
    expect(KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.positionManager).toBe(
      '0x73991a25c818bf1f1128deaab1492d45638de0d3',
    );
    expect(OBSERVED_SELECTORS.swap_and_mint).toBe('0x954543e6');
    expect(OBSERVED_SELECTORS.swap_and_increase).toBe('0x3dce3e25');
    expect(OBSERVED_SELECTORS.compound).toBe('0xb88d4fde');
  });

  it('includes WETH with approve for zap flows, but not the factory (reference-only)', () => {
    const targets = ROBINHOOD_ALLOWLIST.map((d) => d.address.toLowerCase());
    expect(targets).not.toContain(REFERENCE_CONTRACTS.uniswapV3Factory.toLowerCase());
    expect(targets).toContain(REFERENCE_CONTRACTS.weth.toLowerCase());
    const weth = ROBINHOOD_ALLOWLIST.find((d) =>
      sameAddress(d.address, REFERENCE_CONTRACTS.weth),
    );
    expect(weth?.selectors).toEqual(['0x095ea7b3']);
  });

  it('documents every selector it enables', () => {
    for (const dest of ROBINHOOD_ALLOWLIST) {
      for (const sel of dest.selectors) {
        expect(dest.selectorPurpose[sel], `${dest.name} ${sel}`).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// the owner-signed plan
// ---------------------------------------------------------------------------

describe('buildAllowlistPlan', () => {
  const plan = buildAllowlistPlan({ module: MODULE, operator: OPERATOR });

  it('produces exactly 7 transactions: 3 targets, 3 selector batches, 1 operator', () => {
    expect(plan).toHaveLength(7);
  });

  it('puts setOperator LAST, so an authorized key never faces a half-configured module', () => {
    const decoded = plan.map((p) => decodeFunctionData({ abi: MODULE_ABI, data: p.data }).functionName);
    expect(decoded).toEqual([
      'setTargetAllowed',
      'setTargetAllowed',
      'setTargetAllowed',
      'setSelectorsAllowed',
      'setSelectorsAllowed',
      'setSelectorsAllowed',
      'setOperator',
    ]);
  });

  it('uses the batch setter, keeping owner signatures to 7 instead of 8', () => {
    const single = plan.filter(
      (p) => decodeFunctionData({ abi: MODULE_ABI, data: p.data }).functionName === 'setSelectorAllowed',
    );
    expect(single).toHaveLength(0);
  });

  it('sends every transaction to the module with zero value', () => {
    for (const payload of plan) {
      expect(payload.to).toBe(MODULE);
      expect(payload.value).toBe(0n);
    }
  });

  it('encodes the verified destinations and selectors, and nothing else', () => {
    const targetCalls = plan
      .map((p) => decodeFunctionData({ abi: MODULE_ABI, data: p.data }))
      .filter((d) => d.functionName === 'setTargetAllowed');
    // viem returns checksummed addresses from the decoder; compare on the
    // canonical lowercase form the rest of this codebase normalizes to.
    expect(targetCalls.map((d) => String((d.args as readonly unknown[])[0]).toLowerCase())).toEqual([
      KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.v3utils,
      KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.positionManager,
      REFERENCE_CONTRACTS.weth.toLowerCase(),
    ]);
    expect(targetCalls.every((d) => (d.args as readonly unknown[])[1] === true)).toBe(true);

    const selectorCalls = plan
      .map((p) => decodeFunctionData({ abi: MODULE_ABI, data: p.data }))
      .filter((d) => d.functionName === 'setSelectorsAllowed');
    const normalize = (args: readonly unknown[]): unknown[] => [
      String(args[0]).toLowerCase(),
      (args[1] as string[]).map((s) => s.toLowerCase()),
      args[2],
    ];
    expect(normalize(selectorCalls[0]!.args as readonly unknown[])).toEqual([
      KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.v3utils,
      [OBSERVED_SELECTORS.swap_and_mint, OBSERVED_SELECTORS.swap_and_increase],
      true,
    ]);
    expect(normalize(selectorCalls[1]!.args as readonly unknown[])).toEqual([
      KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.positionManager,
      [OBSERVED_SELECTORS.compound],
      true,
    ]);
    expect(normalize(selectorCalls[2]!.args as readonly unknown[])).toEqual([
      REFERENCE_CONTRACTS.weth.toLowerCase(),
      ['0x095ea7b3'],
      true,
    ]);
  });

  it('encodes the operator exactly as given', () => {
    const call = decodeFunctionData({ abi: MODULE_ABI, data: plan[6]!.data });
    const args = call.args as readonly unknown[];
    expect(String(args[0]).toLowerCase()).toBe(OPERATOR);
    expect(args[1]).toBe(true);
  });

  it('--revoke produces the exact inverse: same calls, allowed=false', () => {
    const revoke = buildAllowlistPlan({ module: MODULE, operator: OPERATOR, allowed: false });
    expect(revoke).toHaveLength(plan.length);
    for (let i = 0; i < revoke.length; i += 1) {
      const original = decodeFunctionData({ abi: MODULE_ABI, data: plan[i]!.data });
      const inverse = decodeFunctionData({ abi: MODULE_ABI, data: revoke[i]!.data });
      expect(inverse.functionName).toBe(original.functionName);
      const originalArgs = original.args as readonly unknown[];
      const inverseArgs = inverse.args as readonly unknown[];
      expect(inverseArgs.slice(0, -1)).toEqual(originalArgs.slice(0, -1));
      expect(inverseArgs[inverseArgs.length - 1]).toBe(false);
    }
  });

  it('gives every payload a human-readable description and rationale', () => {
    for (const payload of plan) {
      expect(payload.description.length).toBeGreaterThan(10);
      expect(payload.rationale.length).toBeGreaterThan(10);
      expect(payload.decoded.length).toBeGreaterThan(0);
    }
  });
});

describe('buildEnableModulePayload', () => {
  it('targets the SAFE, not the module — this is the one call the operator can never make', () => {
    const payload = buildEnableModulePayload(SAFE, MODULE);
    expect(payload.to).toBe(SAFE);
    expect(payload.value).toBe(0n);
    const call = decodeFunctionData({ abi: SAFE_ABI, data: payload.data });
    expect(call.functionName).toBe('enableModule');
    expect((call.args as readonly unknown[])[0]).toBe(MODULE);
  });

  it('matches viem encoding directly', () => {
    expect(buildEnableModulePayload(SAFE, MODULE).data).toBe(
      encodeFunctionData({ abi: SAFE_ABI, functionName: 'enableModule', args: [MODULE] }),
    );
  });
});

describe('buildDisableModulePayload / buildSetPausedPayload', () => {
  it('encodes disableModule with the caller-supplied predecessor', () => {
    const prev = '0x0000000000000000000000000000000000000001' as const;
    const call = decodeFunctionData({ abi: SAFE_ABI, data: buildDisableModulePayload(SAFE, prev, MODULE).data });
    expect(call.functionName).toBe('disableModule');
    expect(call.args as readonly unknown[]).toEqual([prev, MODULE]);
  });

  it('encodes setPaused against the module', () => {
    const payload = buildSetPausedPayload(MODULE, true);
    expect(payload.to).toBe(MODULE);
    const call = decodeFunctionData({ abi: MODULE_ABI, data: payload.data });
    expect(call.functionName).toBe('setPaused');
    expect((call.args as readonly unknown[])[0]).toBe(true);
  });
});

describe('renderPayload', () => {
  const rendered = renderPayload(buildEnableModulePayload(SAFE, MODULE), 0, 1);

  it('prints addresses in full — never truncated', () => {
    expect(rendered).toContain(SAFE);
    expect(rendered).toContain(MODULE);
    expect(rendered).not.toMatch(/0x[0-9a-fA-F]{4}…/);
    expect(rendered).not.toMatch(/0x[0-9a-fA-F]{4}\.\.\./);
  });

  it('shows the raw calldata so it can be compared against the signing device', () => {
    expect(rendered).toContain(buildEnableModulePayload(SAFE, MODULE).data);
  });

  it('states that value must be zero', () => {
    expect(rendered).toMatch(/value\s+0/);
  });
});

// ---------------------------------------------------------------------------
// the audit diff
// ---------------------------------------------------------------------------

describe('classifyAllowlist', () => {
  const expected = buildExpectedState(OPERATOR);
  const complete = {
    targets: [...expected.targets],
    selectors: [...expected.selectors],
    operators: [...expected.operators],
  };

  it('passes a correctly configured module', () => {
    const findings = classifyAllowlist(expected, complete);
    expect(findings.ok).toBe(true);
  });

  it('flags a MISSING target', () => {
    const findings = classifyAllowlist(expected, { ...complete, targets: complete.targets.slice(1) });
    expect(findings.ok).toBe(false);
    expect(findings.missingTargets).toHaveLength(1);
  });

  it('flags an EXTRA target — this is what a compromise looks like', () => {
    const rogue = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const findings = classifyAllowlist(expected, { ...complete, targets: [...complete.targets, rogue] });
    expect(findings.ok).toBe(false);
    expect(findings.unexpectedTargets).toEqual([rogue]);
    // Everything intended is still present — a missing-only audit would pass.
    expect(findings.missingTargets).toEqual([]);
    expect(findings.missingSelectors).toEqual([]);
  });

  it('flags an EXTRA selector on an otherwise legitimate destination', () => {
    const rogue = selectorKey(KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.v3utils, '0xdeadbeef');
    const findings = classifyAllowlist(expected, { ...complete, selectors: [...complete.selectors, rogue] });
    expect(findings.ok).toBe(false);
    expect(findings.unexpectedSelectors).toEqual([rogue]);
  });

  it('flags an EXTRA authorized operator', () => {
    const rogue = '0x9999999999999999999999999999999999999999';
    const findings = classifyAllowlist(expected, { ...complete, operators: [...complete.operators, rogue] });
    expect(findings.ok).toBe(false);
    expect(findings.unexpectedOperators).toEqual([rogue]);
  });

  it('flags the intended operator being replaced by a different one', () => {
    const findings = classifyAllowlist(expected, {
      ...complete,
      operators: ['0x9999999999999999999999999999999999999999'],
    });
    expect(findings.missingOperators).toEqual([OPERATOR.toLowerCase()]);
    expect(findings.unexpectedOperators).toHaveLength(1);
  });

  it('is case-insensitive about addresses on both sides', () => {
    const findings = classifyAllowlist(expected, {
      targets: complete.targets.map((t) => t.toUpperCase().replace('0X', '0x')),
      selectors: complete.selectors.map((s) => s.toUpperCase().replace('0X', '0x') as typeof s),
      operators: [OPERATOR.toUpperCase().replace('0X', '0x')],
    });
    expect(findings.ok).toBe(true);
  });

  it('treats an entirely empty module (freshly deployed) as not-configured, not as clean', () => {
    const findings = classifyAllowlist(expected, { targets: [], selectors: [], operators: [] });
    expect(findings.ok).toBe(false);
    expect(findings.missingTargets).toHaveLength(3);
    expect(findings.missingSelectors).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// artifact handling
// ---------------------------------------------------------------------------

describe('extractArtifact', () => {
  const good = {
    bytecode: { object: '0x6080604052', linkReferences: {} },
    metadata: {
      compiler: { version: '0.8.28+commit.abc' },
      settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 } },
    },
  };

  it('pulls out the creation bytecode and compiler settings', () => {
    const artifact = extractArtifact(good, 'x.json');
    expect(artifact.bytecode).toBe('0x6080604052');
    expect(artifact.bytecodeLength).toBe(5);
    expect(artifact.compiler.evmVersion).toBe('shanghai');
    expect(artifact.compiler.optimizer).toBe('enabled, runs=200');
    expect(artifact.warnings).toEqual([]);
  });

  it('refuses EMPTY bytecode instead of deploying nothing', () => {
    expect(() => extractArtifact({ ...good, bytecode: { object: '0x' } }, 'x.json')).toThrow(/EMPTY/);
  });

  it('refuses unlinked library placeholders', () => {
    expect(() =>
      extractArtifact({ ...good, bytecode: { object: '0x6080__$0123456789abcdef0123456789abcdef01$__' } }, 'x.json'),
    ).toThrow(/placeholder/);
    expect(() =>
      extractArtifact({ ...good, bytecode: { object: '0x6080', linkReferences: { 'L.sol': {} } } }, 'x.json'),
    ).toThrow(/link references/);
  });

  it('warns when the artifact was built for a different EVM version than foundry.toml pins', () => {
    const artifact = extractArtifact(
      { ...good, metadata: { ...good.metadata, settings: { ...good.metadata.settings, evmVersion: 'cancun' } } },
      'x.json',
    );
    expect(artifact.warnings.join(' ')).toMatch(/cancun/);
  });

  it('rejects anything that is not a Foundry artifact', () => {
    expect(() => extractArtifact({}, 'x.json')).toThrow(/bytecode/);
    expect(() => extractArtifact(null, 'x.json')).toThrow(ArgError);
    expect(() => extractArtifact({ bytecode: { object: 'nothex' } }, 'x.json')).toThrow(ArgError);
  });
});

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

describe('tally / renderVerdict', () => {
  const row = (status: CheckResult['status']): CheckResult => ({ status, label: 'l', detail: 'd' });

  it('is not ok when anything failed', () => {
    expect(tally([row('pass'), row('fail')]).ok).toBe(false);
    expect(tally([row('pass'), row('warn'), row('skip')]).ok).toBe(true);
  });

  it('says NOT SAFE TO PROCEED on a failure', () => {
    expect(renderVerdict(tally([row('fail')]), 'x')).toMatch(/NOT SAFE TO PROCEED/);
  });

  it('never claims a clean run when checks were skipped', () => {
    const verdict = renderVerdict(tally([row('pass'), row('skip')]), 'x');
    expect(verdict).not.toMatch(/all \d+ check\(s\) passed/);
    expect(verdict).toMatch(/could not be run/);
  });

  it('never claims a clean run when there are warnings', () => {
    expect(renderVerdict(tally([row('pass'), row('warn')]), 'x')).toMatch(/warning/);
  });

  it('reports a genuinely clean run plainly', () => {
    expect(renderVerdict(tally([row('pass'), row('pass')]), 'The setup')).toMatch(/all 2 check\(s\) passed/);
  });
});

describe('renderChecks', () => {
  it('prints the full detail string, including full-length addresses', () => {
    const output = renderChecks([{ status: 'pass', label: 'target', detail: SAFE }]);
    expect(output).toContain(SAFE);
  });

  it('emits no ANSI escapes when color is off', () => {
    const output = renderChecks([{ status: 'fail', label: 'x', detail: 'y' }], { color: false });
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).toContain('FAIL');
  });

  it('renders notes underneath the row', () => {
    const output = renderChecks([{ status: 'warn', label: 'x', detail: 'y', notes: ['note one'] }]);
    expect(output).toContain('note one');
  });
});

describe('wrap', () => {
  it('keeps every word and adds no characters other than newlines', () => {
    const text = 'the module bounds native value only and does not bound erc20 amounts at all';
    expect(wrap(text, 20).split('\n').join(' ')).toBe(text);
  });

  it('respects the indent', () => {
    for (const line of wrap('a b c d e f g h', 6, '  ').split('\n')) {
      expect(line.startsWith('  ')).toBe(true);
    }
  });
});
