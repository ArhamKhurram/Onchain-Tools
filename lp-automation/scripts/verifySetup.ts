#!/usr/bin/env tsx
//
// verifySetup.ts — READ-ONLY post-setup audit. Run it after the owner
// transactions land, and again whenever you want reassurance.
//
// It answers two questions, and the second one is the important one:
//
//   1. Is everything I intended actually configured?
//   2. Is ANYTHING ELSE configured?
//
// Question 2 is what catches a compromise or a fat-fingered extra signature. A
// system with one extra allowlisted destination works exactly as well as a
// correct one, right up until it does not — so this script enumerates the live
// state rather than only spot-checking the entries it expects.
//
// Solidity mappings are not enumerable, so "what is allowed?" is answered by
// replaying the module's TargetAllowedSet / SelectorAllowedSet / OperatorSet
// events and then re-reading current state for every address they ever touched.
// If the log query fails or is truncated, this script says the enumeration did
// not happen and does NOT report a clean bill of health.
//
// Run:  npx tsx scripts/verifySetup.ts
//       npx tsx scripts/verifySetup.ts --from-block 12345    (deploy block; much faster)

import type { Address, PublicClient } from 'viem';
import { MODULE_ABI, SAFE_ABI } from './lib/abi.js';
import {
  ArgError,
  findPrivateKeyLikeArgs,
  formatEther,
  parseAmount,
  parseArgs,
  parseFromBlock,
  parseInteger,
  redactRpcUrl,
  requireAddress,
  sameAddress,
} from './lib/args.js';
import { assertChainId, buildPublicClient, hasCode } from './lib/client.js';
import { EXIT_FAILED_CHECK, EXIT_OK, print, runScript, wantsHelp } from './lib/cli.js';
import {
  BLOCK_EXPLORER,
  EXPECTED_CHAIN_ID,
  MIN_OPERATOR_GAS_WEI,
  PUBLIC_RPC_URL,
  ROBINHOOD_ALLOWLIST,
  SENTINEL_MODULES,
} from './lib/constants.js';
import { loadEnv, optionalEnv, resolveOperatorAddress } from './lib/env.js';
import {
  buildExpectedState,
  classifyAllowlist,
  selectorKey,
  type ObservedState,
  type SelectorKey,
} from './lib/plan.js';
import { banner, heading, renderChecks, renderVerdict, tally, type CheckResult } from './lib/report.js';

const HELP = `
verifySetup.ts — read-only audit of a configured Safe + module

  npx tsx scripts/verifySetup.ts [flags]

Sends nothing. Needs no private key. Exits 1 if anything is wrong.

Flags
  --safe <0x...>          Override LP_SAFE_ADDRESS.
  --module <0x...>        Override LP_MODULE_ADDRESS.
  --operator <0x...>      Override the expected operator address.
  --from-block <n>        Start block for the event enumeration. Use the module's
                          deploy block (LP_MODULE_DEPLOY_BLOCK). Without it this
                          scans from genesis, which many RPCs will refuse.
  --expect-max-value-eth <n> / --expect-max-value-wei <n>
  --expect-daily-cap-eth <n> / --expect-daily-cap-wei <n>
                          Assert the caps equal these values. Without them the
                          caps are reported but not judged.
  --rpc-url <url>         Override LP_RPC_URL.
  --allow-chain <id>      Accept a chain id other than ${EXPECTED_CHAIN_ID}.
  --no-color              Plain output.
  --help                  This text.

Read the "unexpected" section even when everything else is green. An extra
allowlist entry is exactly what a compromise looks like from the outside.
`;

interface EnumerationResult {
  readonly observed: ObservedState;
  readonly ok: boolean;
  readonly error?: string;
  readonly fromBlock: string;
}

/**
 * Replay the module's admin events, then re-read current state for every
 * address/selector they ever mentioned.
 *
 * Reading current state rather than trusting the last event matters: an entry
 * set true and then false has two events, and only the chain knows which one
 * won. The events are used purely as an index of "what to ask about".
 */
async function enumerateLiveState(
  publicClient: PublicClient,
  moduleAddress: Address,
  fromBlock: bigint | 'earliest',
): Promise<EnumerationResult> {
  const label = fromBlock === 'earliest' ? 'earliest' : fromBlock.toString();
  try {
    const [targetLogs, selectorLogs, operatorLogs] = await Promise.all([
      publicClient.getContractEvents({
        address: moduleAddress,
        abi: MODULE_ABI,
        eventName: 'TargetAllowedSet',
        fromBlock,
        toBlock: 'latest',
      }),
      publicClient.getContractEvents({
        address: moduleAddress,
        abi: MODULE_ABI,
        eventName: 'SelectorAllowedSet',
        fromBlock,
        toBlock: 'latest',
      }),
      publicClient.getContractEvents({
        address: moduleAddress,
        abi: MODULE_ABI,
        eventName: 'OperatorSet',
        fromBlock,
        toBlock: 'latest',
      }),
    ]);

    const candidateTargets = new Set<string>();
    const candidateSelectors = new Set<SelectorKey>();
    const candidateOperators = new Set<string>();

    for (const log of targetLogs) {
      const target = log.args.target;
      if (target) candidateTargets.add(target.toLowerCase());
    }
    for (const log of selectorLogs) {
      const target = log.args.target;
      const selector = log.args.selector;
      if (target && selector) {
        candidateTargets.add(target.toLowerCase());
        candidateSelectors.add(selectorKey(target, selector));
      }
    }
    for (const log of operatorLogs) {
      const operator = log.args.operator;
      if (operator) candidateOperators.add(operator.toLowerCase());
    }

    // Always ask about the intended entries too, so a missing event (pruned
    // node, wrong fromBlock) cannot turn "not configured" into "not mentioned".
    for (const dest of ROBINHOOD_ALLOWLIST) {
      candidateTargets.add(dest.address.toLowerCase());
      for (const sel of dest.selectors) candidateSelectors.add(selectorKey(dest.address, sel));
    }

    const targets: string[] = [];
    for (const target of candidateTargets) {
      const allowed = (await publicClient.readContract({
        address: moduleAddress,
        abi: MODULE_ABI,
        functionName: 'isAllowedTarget',
        args: [target as Address],
      })) as boolean;
      if (allowed) targets.push(target);
    }

    const selectors: SelectorKey[] = [];
    for (const key of candidateSelectors) {
      const [target, selector] = key.split(':') as [string, string];
      const allowed = (await publicClient.readContract({
        address: moduleAddress,
        abi: MODULE_ABI,
        functionName: 'isAllowedSelector',
        args: [target as Address, selector as `0x${string}`],
      })) as boolean;
      if (allowed) selectors.push(key);
    }

    const operators: string[] = [];
    for (const operator of candidateOperators) {
      const allowed = (await publicClient.readContract({
        address: moduleAddress,
        abi: MODULE_ABI,
        functionName: 'isOperator',
        args: [operator as Address],
      })) as boolean;
      if (allowed) operators.push(operator);
    }

    return { observed: { targets, selectors, operators }, ok: true, fromBlock: label };
  } catch (err) {
    return {
      observed: { targets: [], selectors: [], operators: [] },
      ok: false,
      error: err instanceof Error ? err.message.split('\n')[0] : String(err),
      fromBlock: label,
    };
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    print(HELP);
    return EXIT_OK;
  }

  const leaked = findPrivateKeyLikeArgs(argv);
  if (leaked.length > 0) {
    throw new ArgError(
      `Argument #${leaked[0]! + 1} looks like a private key. This script is read-only and does not want ` +
        'one. Rotate whatever you just pasted.',
    );
  }

  loadEnv();
  const args = parseArgs(argv);
  const color = !args.booleans.has('no-color') && process.stdout.isTTY === true;
  const allowChain = parseInteger(args.values.get('allow-chain'), '--allow-chain');

  const safeAddress = requireAddress(
    args.values.get('safe') ?? optionalEnv('LP_SAFE_ADDRESS'),
    'LP_SAFE_ADDRESS (or --safe)',
  ) as Address;
  const moduleAddress = requireAddress(
    args.values.get('module') ?? optionalEnv('LP_MODULE_ADDRESS'),
    'LP_MODULE_ADDRESS (or --module)',
  ) as Address;
  const operator = resolveOperatorAddress(args.values.get('operator')).address as Address;

  const fromBlock =
    parseFromBlock(args.values.get('from-block') ?? optionalEnv('LP_MODULE_DEPLOY_BLOCK')) ?? 'earliest';

  const expectedMaxValue = hasAny(args.values, 'expect-max-value-wei', 'expect-max-value-eth')
    ? parseAmount(
        { wei: args.values.get('expect-max-value-wei'), eth: args.values.get('expect-max-value-eth') },
        '--expect-max-value',
      )
    : null;
  const expectedDailyCap = hasAny(args.values, 'expect-daily-cap-wei', 'expect-daily-cap-eth')
    ? parseAmount(
        { wei: args.values.get('expect-daily-cap-wei'), eth: args.values.get('expect-daily-cap-eth') },
        '--expect-daily-cap',
      )
    : null;

  const rpcUrlRaw = args.values.get('rpc-url') ?? optionalEnv('LP_RPC_URL') ?? PUBLIC_RPC_URL;
  const { publicClient, rpcUrl, rpcWarnings } = buildPublicClient(rpcUrlRaw);
  const { chainId, note } = await assertChainId(publicClient, allowChain);

  print(banner('VERIFY SETUP — read-only audit. Nothing here sends a transaction.'));
  print(`  chain id  ${chainId}${note === undefined ? '' : `   (${note})`}`);
  print(`  rpc       ${redactRpcUrl(rpcUrl)}`);
  print(`  safe      ${safeAddress}`);
  print(`  module    ${moduleAddress}`);
  print(`  operator  ${operator}`);
  for (const w of rpcWarnings) print(`  WARN      ${w}`);

  const results: CheckResult[] = [];

  // --------------------------------------------------------- module identity
  print(heading('1. Module identity and binding'));
  const identity: CheckResult[] = [];

  const moduleCode = await hasCode(publicClient, moduleAddress);
  identity.push({
    status: moduleCode > 0 ? 'pass' : 'fail',
    label: 'Module has code',
    detail: moduleCode > 0 ? `${moduleAddress}  (${moduleCode} bytes)` : `${moduleAddress} — NO CODE`,
  });

  if (moduleCode === 0) {
    print(renderChecks(identity, { color }));
    results.push(...identity);
    print(banner(renderVerdict(tally(results), 'The setup')));
    print('  Stopping: there is no module at that address.\n');
    return EXIT_FAILED_CHECK;
  }

  const boundSafe = (await publicClient.readContract({
    address: moduleAddress,
    abi: MODULE_ABI,
    functionName: 'safe',
  })) as Address;
  identity.push({
    status: sameAddress(boundSafe, safeAddress) ? 'pass' : 'fail',
    label: 'module.safe() matches',
    detail: `${boundSafe}`,
    notes: sameAddress(boundSafe, safeAddress)
      ? undefined
      : [`Expected ${safeAddress}. \`safe\` is immutable — this module can never be administered by your Safe.`],
  });

  const enabledOnSafe = (await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'isModuleEnabled',
    args: [moduleAddress],
  })) as boolean;
  identity.push({
    status: enabledOnSafe ? 'pass' : 'fail',
    label: 'Enabled on the Safe',
    detail: enabledOnSafe ? 'yes' : 'NO — the module cannot execute anything until an owner signs enableModule',
  });

  print(renderChecks(identity, { color }));
  results.push(...identity);

  // ------------------------------------------------------------------- caps
  print(heading('2. Caps and pause state'));
  const capChecks: CheckResult[] = [];

  const [maxValuePerTx, dailyValueCap, paused, spent, remaining] = (await Promise.all([
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'maxValuePerTx' }),
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'dailyValueCap' }),
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'paused' }),
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'spentInCurrentWindow' }),
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'remainingDailyAllowance' }),
  ])) as [bigint, bigint, boolean, bigint, bigint];

  capChecks.push({
    status: expectedMaxValue === null ? 'info' : maxValuePerTx === expectedMaxValue ? 'pass' : 'fail',
    label: 'maxValuePerTx',
    detail: `${maxValuePerTx} wei  (${formatEther(maxValuePerTx)} ETH)`,
    notes:
      expectedMaxValue !== null && maxValuePerTx !== expectedMaxValue
        ? [`Expected ${expectedMaxValue} wei (${formatEther(expectedMaxValue)} ETH). Someone changed it.`]
        : expectedMaxValue === null
          ? ['No --expect-max-value given, so this is reported but not judged.']
          : undefined,
  });

  capChecks.push({
    status: expectedDailyCap === null ? 'info' : dailyValueCap === expectedDailyCap ? 'pass' : 'fail',
    label: 'dailyValueCap',
    detail: `${dailyValueCap} wei  (${formatEther(dailyValueCap)} ETH)`,
    notes:
      expectedDailyCap !== null && dailyValueCap !== expectedDailyCap
        ? [`Expected ${expectedDailyCap} wei (${formatEther(expectedDailyCap)} ETH). Someone changed it.`]
        : [
            `Fixed UTC-day bucket: up to ${formatEther(dailyValueCap * 2n)} ETH can leave in one burst`,
            'straddling midnight UTC. Deliberate tradeoff — contracts/README.md §3.',
          ],
  });

  capChecks.push({
    status: maxValuePerTx > dailyValueCap ? 'warn' : 'pass',
    label: 'Caps are coherent',
    detail:
      maxValuePerTx > dailyValueCap
        ? 'maxValuePerTx exceeds dailyValueCap — the per-tx cap is unreachable'
        : 'maxValuePerTx <= dailyValueCap',
  });

  capChecks.push({
    status: paused ? 'warn' : 'pass',
    label: 'Not paused',
    detail: paused ? 'PAUSED — all operator execution is currently halted' : 'running',
    notes: paused ? ['If you did not pause it, find out who did before unpausing.'] : undefined,
  });

  capChecks.push({
    status: 'info',
    label: "Today's spend",
    detail: `${spent} wei spent · ${remaining} wei remaining  (${formatEther(remaining)} ETH)`,
  });

  print(renderChecks(capChecks, { color }));
  results.push(...capChecks);

  // ------------------------------------------------------------- allowlists
  print(heading('3. Allowlists — intended entries'));
  const allowChecks: CheckResult[] = [];

  for (const dest of ROBINHOOD_ALLOWLIST) {
    const targetAllowed = (await publicClient.readContract({
      address: moduleAddress,
      abi: MODULE_ABI,
      functionName: 'isAllowedTarget',
      args: [dest.address],
    })) as boolean;
    allowChecks.push({
      status: targetAllowed ? 'pass' : 'fail',
      label: `target ${dest.name}`,
      detail: `${dest.address}  ${targetAllowed ? 'allowed' : 'NOT ALLOWED'}`,
    });

    for (const sel of dest.selectors) {
      const selAllowed = (await publicClient.readContract({
        address: moduleAddress,
        abi: MODULE_ABI,
        functionName: 'isAllowedSelector',
        args: [dest.address, sel],
      })) as boolean;
      allowChecks.push({
        status: selAllowed ? 'pass' : 'fail',
        label: `  selector ${sel}`,
        detail: `on ${dest.address}  ${selAllowed ? 'allowed' : 'NOT ALLOWED'}  — ${dest.selectorPurpose[sel] ?? ''}`,
      });
    }
  }

  const operatorAuthorized = (await publicClient.readContract({
    address: moduleAddress,
    abi: MODULE_ABI,
    functionName: 'isOperator',
    args: [operator],
  })) as boolean;
  allowChecks.push({
    status: operatorAuthorized ? 'pass' : 'fail',
    label: 'operator authorized',
    detail: `${operator}  ${operatorAuthorized ? 'authorized' : 'NOT AUTHORIZED'}`,
  });

  print(renderChecks(allowChecks, { color }));
  results.push(...allowChecks);

  // ------------------------------------------------- anything that shouldn't be
  print(heading('4. Anything allowlisted that should NOT be'));
  const surpriseChecks: CheckResult[] = [];

  const enumeration = await enumerateLiveState(publicClient, moduleAddress, fromBlock);

  if (!enumeration.ok) {
    surpriseChecks.push({
      status: 'fail',
      label: 'Enumeration',
      detail: `could not replay module events from block ${enumeration.fromBlock}: ${enumeration.error}`,
      notes: [
        'THIS IS NOT A PASS. Without the event replay this script cannot tell you whether anything',
        'extra is allowlisted — only that the entries you expected are present, which a compromised',
        'setup also satisfies. Re-run with --from-block <module deploy block>; most public RPCs cap',
        'eth_getLogs ranges and will refuse a scan from genesis on a 100ms-block chain.',
      ],
    });
  } else {
    const expected = buildExpectedState(operator);
    const findings = classifyAllowlist(expected, enumeration.observed);

    surpriseChecks.push({
      status: findings.unexpectedTargets.length === 0 ? 'pass' : 'fail',
      label: 'No unexpected targets',
      detail:
        findings.unexpectedTargets.length === 0
          ? `${enumeration.observed.targets.length} allowlisted target(s), all expected`
          : `${findings.unexpectedTargets.length} UNEXPECTED allowlisted destination(s)`,
      notes: findings.unexpectedTargets.length === 0 ? undefined : findings.unexpectedTargets,
    });

    surpriseChecks.push({
      status: findings.unexpectedSelectors.length === 0 ? 'pass' : 'fail',
      label: 'No unexpected selectors',
      detail:
        findings.unexpectedSelectors.length === 0
          ? `${enumeration.observed.selectors.length} allowlisted selector(s), all expected`
          : `${findings.unexpectedSelectors.length} UNEXPECTED (target, selector) pair(s)`,
      notes:
        findings.unexpectedSelectors.length === 0
          ? undefined
          : findings.unexpectedSelectors.map((k) => {
              const [target, selector] = k.split(':');
              return `selector ${selector} on ${target}`;
            }),
    });

    surpriseChecks.push({
      status: findings.unexpectedOperators.length === 0 ? 'pass' : 'fail',
      label: 'No unexpected operators',
      detail:
        findings.unexpectedOperators.length === 0
          ? `${enumeration.observed.operators.length} authorized operator(s), all expected`
          : `${findings.unexpectedOperators.length} UNEXPECTED authorized key(s)`,
      notes:
        findings.unexpectedOperators.length === 0
          ? undefined
          : [
              ...findings.unexpectedOperators,
              'An operator you did not authorize can execute within the allowlist right now.',
              'Send setPaused(true) first, ask questions second.',
            ],
    });

    surpriseChecks.push({
      status: 'info',
      label: 'Scanned from block',
      detail:
        enumeration.fromBlock === 'earliest'
          ? 'earliest (full history) — set LP_MODULE_DEPLOY_BLOCK to make this fast'
          : enumeration.fromBlock,
    });
  }

  print(renderChecks(surpriseChecks, { color }));
  results.push(...surpriseChecks);

  // ------------------------------------------------------------ Safe hygiene
  print(heading('5. Safe hygiene'));
  const safeChecks: CheckResult[] = [];

  const owners = (await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'getOwners',
  })) as readonly Address[];
  const threshold = (await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'getThreshold',
  })) as bigint;

  const operatorIsOwner = owners.some((o) => sameAddress(o, operator));
  safeChecks.push({
    status: operatorIsOwner ? 'fail' : 'pass',
    label: 'Operator is not a Safe owner',
    detail: operatorIsOwner ? 'THE HOT KEY IS A SAFE OWNER — the module provides no protection' : 'confirmed',
    notes: operatorIsOwner
      ? ['An owner can disable the module, raise the caps, or move everything. Remove it from the owner set.']
      : undefined,
  });

  safeChecks.push({
    status: threshold >= 2n ? 'pass' : 'warn',
    label: 'Owner threshold',
    detail: `${threshold} of ${owners.length}`,
    notes: owners.map((o, i) => `owner[${i}] = ${o}`),
  });

  try {
    const [enabledModules] = (await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: 'getModulesPaginated',
      args: [SENTINEL_MODULES, 50n],
    })) as [readonly Address[], Address];
    const extras = enabledModules.filter((m) => !sameAddress(m, moduleAddress));
    safeChecks.push({
      status: extras.length === 0 ? 'pass' : 'fail',
      label: 'No unexpected modules',
      detail:
        extras.length === 0
          ? `${enabledModules.length} module enabled, and it is ours`
          : `${extras.length} OTHER module(s) enabled on this Safe`,
      notes:
        extras.length === 0
          ? undefined
          : [
              ...extras,
              'Every enabled module can move funds out of this Safe with no owner signature.',
              'If you did not add these deliberately, treat the Safe as compromised.',
            ],
    });
  } catch (err) {
    safeChecks.push({
      status: 'fail',
      label: 'No unexpected modules',
      detail: `could not enumerate modules: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      notes: ['Not a pass — this is the check that finds a module you did not install.'],
    });
  }

  const balance = await publicClient.getBalance({ address: operator });
  safeChecks.push({
    status: balance === 0n ? 'fail' : balance < MIN_OPERATOR_GAS_WEI ? 'warn' : 'pass',
    label: 'Operator gas',
    detail: `${formatEther(balance)} ETH  (${balance} wei)`,
    notes: balance === 0n ? ['Zero balance — the operator cannot pay for its own transactions.'] : undefined,
  });

  print(renderChecks(safeChecks, { color }));
  results.push(...safeChecks);

  // ------------------------------------------------------------------ verdict
  const t = tally(results);
  print(banner(renderVerdict(t, 'The Safe + module setup')));
  print(`  pass ${t.pass} · fail ${t.fail} · warn ${t.warn} · skipped ${t.skip} · info ${t.info}`);
  print(`  module   ${BLOCK_EXPLORER}/address/${moduleAddress}`);
  print(`  safe     ${BLOCK_EXPLORER}/address/${safeAddress}`);
  print('');
  if (t.ok) {
    print('  If you are about to arm the runner for the first time: do it with dust-sized caps,');
    print('  watch one full lifecycle end to end, then raise the caps with an owner-signed');
    print('  setDailyValueCap. Raising a cap costs one signature; a loss costs the loss.');
    print('');
  }

  return t.ok ? EXIT_OK : EXIT_FAILED_CHECK;
}

function hasAny(values: ReadonlyMap<string, string>, ...keys: string[]): boolean {
  return keys.some((k) => values.has(k));
}

await runScript('verifySetup', main);
