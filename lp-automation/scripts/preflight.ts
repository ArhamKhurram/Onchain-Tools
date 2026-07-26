#!/usr/bin/env tsx
//
// preflight.ts — READ-ONLY. Safe to run at any time, as often as you like.
//
// This is the script you run first, and the one you run again whenever you are
// not sure. It sends no transactions, needs no private key, and changes nothing.
// It answers one question: "is the ground I am about to build on actually
// there?"
//
// It checks, in order:
//   1. the RPC is reachable and is REALLY chain 4663
//   2. Safe v1.4.1's singleton and proxy factory are deployed here
//   3. your Safe exists, and reports its owners and threshold
//   4. the automation hot key is NOT one of those owners
//   5. both Krystal destinations have code
//   6. the operator address has gas
//   7. (if already deployed) your module's bindings and caps
//
// Run:  npx tsx scripts/preflight.ts
//
// Anything FAIL means stop. Anything skip means a check did not run — which is
// not the same as a check that passed, and the summary says so.

import { formatEther as viemFormatEther, type Address } from 'viem';
import { MODULE_ABI, SAFE_ABI } from './lib/abi.js';
import {
  ArgError,
  formatEther,
  parseArgs,
  parseInteger,
  redactRpcUrl,
  requireAddress,
  sameAddress,
  findPrivateKeyLikeArgs,
} from './lib/args.js';
import { assertChainId, buildPublicClient, hasCode } from './lib/client.js';
import { EXIT_FAILED_CHECK, EXIT_OK, print, runScript, wantsHelp } from './lib/cli.js';
import {
  BLOCK_EXPLORER,
  EXPECTED_CHAIN_ID,
  MIN_OPERATOR_GAS_WEI,
  PUBLIC_RPC_URL,
  ROBINHOOD_ALLOWLIST,
  SAFE_DEPLOYMENTS,
  SENTINEL_MODULES,
} from './lib/constants.js';
import { loadEnv, optionalEnv, resolveOperatorAddress } from './lib/env.js';
import {
  banner,
  heading,
  renderChecks,
  renderVerdict,
  tally,
  type CheckResult,
} from './lib/report.js';

const HELP = `
preflight.ts — read-only readiness check for the LP automation setup

  npx tsx scripts/preflight.ts [flags]

This script NEVER sends a transaction and NEVER needs a private key.

Flags
  --rpc-url <url>       Override LP_RPC_URL for this run.
  --safe <0x...>        Override LP_SAFE_ADDRESS.
  --module <0x...>      Override LP_MODULE_ADDRESS (optional; skipped if unset).
  --operator <0x...>    Override the operator address.
  --allow-chain <id>    Accept a chain id other than ${EXPECTED_CHAIN_ID}. Refuses without it.
  --no-color            Plain output.
  --help                This text.

Environment (from lp-automation/.env, never overriding real env vars)
  LP_RPC_URL              HTTPS JSON-RPC endpoint. Public fallback: ${PUBLIC_RPC_URL}
  LP_SAFE_ADDRESS         The Safe holding the funds.
  LP_MODULE_ADDRESS       The deployed OctAutomationModule (optional at this stage).
  LP_OPERATOR_ADDRESS     The automation hot key's ADDRESS. Preferred here — this
                          script does not want your key and will not read it if
                          this is set.
  LP_OPERATOR_PRIVATE_KEY Only used to derive the address when LP_OPERATOR_ADDRESS
                          is absent. Never printed, never logged.

Exit codes: 0 all passed · 1 at least one FAIL · 2 bad usage/config
`;

async function safeRead<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
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
      `Argument #${leaked[0]! + 1} looks like a private key. This tooling never accepts keys on the ` +
        'command line (argv is visible in shell history and in `ps`). Put it in the environment instead. ' +
        'Consider that key exposed and rotate it.',
    );
  }

  loadEnv();
  const args = parseArgs(argv);
  const color = !args.booleans.has('no-color') && process.stdout.isTTY === true;
  const allowChain = parseInteger(args.values.get('allow-chain'), '--allow-chain');

  const rpcUrlRaw = args.values.get('rpc-url') ?? optionalEnv('LP_RPC_URL') ?? PUBLIC_RPC_URL;
  const { publicClient, rpcUrl, rpcWarnings } = buildPublicClient(rpcUrlRaw);

  print(banner('PREFLIGHT — read-only. Nothing here sends a transaction.'));

  const results: CheckResult[] = [];

  // ---------------------------------------------------------------- connection
  print(heading('1. Connection'));
  const connection: CheckResult[] = [];

  connection.push({
    status: 'info',
    label: 'RPC endpoint',
    detail: redactRpcUrl(rpcUrl),
    notes:
      rpcUrlRaw === PUBLIC_RPC_URL
        ? ['Using the public endpoint. Fine for reading; get a provider URL before running automation.']
        : undefined,
  });
  for (const w of rpcWarnings) connection.push({ status: 'warn', label: 'RPC transport', detail: w });

  let chainId: number | null = null;
  const chainCheck = await safeRead(() => assertChainId(publicClient, allowChain));
  if (chainCheck.ok) {
    chainId = chainCheck.value.chainId;
    connection.push({
      status: chainCheck.value.note === undefined ? 'pass' : 'warn',
      label: 'Chain id',
      detail: `${chainId} (expected ${EXPECTED_CHAIN_ID}, Robinhood Chain)`,
      notes: chainCheck.value.note === undefined ? undefined : [chainCheck.value.note],
    });
  } else {
    connection.push({ status: 'fail', label: 'Chain id', detail: chainCheck.error });
  }

  const block = await safeRead(() => publicClient.getBlock());
  if (block.ok) {
    const ageSeconds = Math.round(Date.now() / 1000 - Number(block.value.timestamp));
    connection.push({
      status: ageSeconds > 120 ? 'warn' : 'pass',
      label: 'Latest block',
      detail: `#${block.value.number} · ${ageSeconds}s old · ${new Date(
        Number(block.value.timestamp) * 1000,
      ).toISOString()}`,
      notes:
        ageSeconds > 120
          ? ['The chain tip is stale from this endpoint. Either the node is behind or your clock is wrong.']
          : undefined,
    });
  } else {
    connection.push({ status: 'fail', label: 'Latest block', detail: block.error });
  }

  print(renderChecks(connection, { color }));
  results.push(...connection);

  if (chainId === null) {
    print(`\n${renderVerdict(tally(results), 'The setup')}`);
    print('\nStopping: without a confirmed chain id nothing below can be trusted.\n');
    return EXIT_FAILED_CHECK;
  }

  // ------------------------------------------------------- Safe infrastructure
  print(heading('2. Safe infrastructure on this chain'));
  const infra: CheckResult[] = [];

  for (const [label, address] of [
    ['Safe v1.4.1 singleton', SAFE_DEPLOYMENTS.v1_4_1.singleton],
    ['Safe v1.4.1 proxy factory', SAFE_DEPLOYMENTS.v1_4_1.proxyFactory],
  ] as const) {
    const size = await safeRead(() => hasCode(publicClient, address));
    infra.push(
      size.ok
        ? {
            status: size.value > 0 ? 'pass' : 'fail',
            label,
            detail:
              size.value > 0
                ? `${address}  (${size.value} bytes of code)`
                : `${address}  — NO CODE. Safe v1.4.1 is not deployed here; do not create a Safe at this address.`,
          }
        : { status: 'fail', label, detail: `${address} — ${size.error}` },
    );
  }

  const legacy = await safeRead(() => hasCode(publicClient, SAFE_DEPLOYMENTS.v1_3_0.singleton));
  infra.push({
    status: 'info',
    label: 'Safe v1.3.0 singleton',
    detail:
      legacy.ok && legacy.value > 0
        ? `${SAFE_DEPLOYMENTS.v1_3_0.singleton}  (${legacy.value} bytes) — also present. Prefer v1.4.1 for a new Safe.`
        : `${SAFE_DEPLOYMENTS.v1_3_0.singleton} — not present`,
  });

  print(renderChecks(infra, { color }));
  results.push(...infra);

  // ------------------------------------------------------------------ your Safe
  print(heading('3. Your Safe'));
  const safeRaw = args.values.get('safe') ?? optionalEnv('LP_SAFE_ADDRESS');
  const safeChecks: CheckResult[] = [];
  let safeAddress: Address | null = null;
  let safeOwners: readonly Address[] = [];

  if (safeRaw === undefined) {
    safeChecks.push({
      status: 'skip',
      label: 'LP_SAFE_ADDRESS',
      detail: 'not set — you have not created the Safe yet, or have not recorded it.',
      notes: [
        'That is fine if you are at step 1. Create the Safe at app.safe.global with your OFFLINE',
        'owner keys (threshold 2-of-2 recommended), then set LP_SAFE_ADDRESS and re-run this.',
      ],
    });
  } else {
    safeAddress = requireAddress(safeRaw, 'LP_SAFE_ADDRESS');
    const size = await safeRead(() => hasCode(publicClient, safeAddress!));
    if (size.ok && size.value > 0) {
      safeChecks.push({ status: 'pass', label: 'Safe contract', detail: `${safeAddress}  (${size.value} bytes)` });

      const version = await safeRead(() =>
        publicClient.readContract({ address: safeAddress!, abi: SAFE_ABI, functionName: 'VERSION' }),
      );
      safeChecks.push({
        status: version.ok ? 'pass' : 'warn',
        label: 'Safe version',
        detail: version.ok
          ? `${version.value}${version.value === '1.4.1' ? '' : '  — module interface matches 1.3.0/1.4.1; verify before use'}`
          : `could not read VERSION(): ${version.error} — is this address really a Safe?`,
      });

      const owners = await safeRead(() =>
        publicClient.readContract({ address: safeAddress!, abi: SAFE_ABI, functionName: 'getOwners' }),
      );
      const threshold = await safeRead(() =>
        publicClient.readContract({ address: safeAddress!, abi: SAFE_ABI, functionName: 'getThreshold' }),
      );

      if (owners.ok && threshold.ok) {
        safeOwners = owners.value as readonly Address[];
        safeChecks.push({
          status: 'info',
          label: 'Owners',
          detail: `${safeOwners.length} owner(s), threshold ${threshold.value}`,
          notes: safeOwners.map((o, i) => `owner[${i}] = ${o}`),
        });
        safeChecks.push({
          status: threshold.value >= 2n ? 'pass' : 'warn',
          label: 'Threshold',
          detail: `${threshold.value} of ${safeOwners.length}`,
          notes:
            threshold.value >= 2n
              ? undefined
              : [
                  'Threshold 1 means a single owner key can do anything, including disabling the module.',
                  'contracts/README.md §5 recommends 2-of-2 with offline keys. Not fatal, but know the exposure.',
                ],
        });
      } else {
        safeChecks.push({
          status: 'fail',
          label: 'Owners / threshold',
          detail: owners.ok ? (threshold as { error: string }).error : (owners as { error: string }).error,
        });
      }

      const modules = await safeRead(() =>
        publicClient.readContract({
          address: safeAddress!,
          abi: SAFE_ABI,
          functionName: 'getModulesPaginated',
          args: [SENTINEL_MODULES, 20n],
        }),
      );
      if (modules.ok) {
        const enabled = modules.value[0] as readonly Address[];
        safeChecks.push({
          status: 'info',
          label: 'Enabled modules',
          detail: enabled.length === 0 ? 'none' : `${enabled.length} enabled`,
          notes: enabled.map((m, i) => `module[${i}] = ${m}`),
        });
      } else {
        safeChecks.push({ status: 'warn', label: 'Enabled modules', detail: modules.error });
      }
    } else if (size.ok) {
      safeChecks.push({
        status: 'fail',
        label: 'Safe contract',
        detail: `${safeAddress} — NO CODE AT THIS ADDRESS.`,
        notes: [
          'Either the Safe was never created, it was created on a different chain, or the address is',
          'wrong. Do not proceed. Nothing downstream is meaningful if the Safe does not exist.',
        ],
      });
    } else {
      safeChecks.push({ status: 'fail', label: 'Safe contract', detail: `${safeAddress} — ${size.error}` });
    }
  }

  print(renderChecks(safeChecks, { color }));
  results.push(...safeChecks);

  // ------------------------------------------------------------------- operator
  print(heading('4. Automation hot key (operator)'));
  const operatorChecks: CheckResult[] = [];
  let operator: Address | null = null;

  try {
    const resolved = resolveOperatorAddress(args.values.get('operator'));
    operator = resolved.address;
    operatorChecks.push({
      status: 'info',
      label: 'Operator address',
      detail: `${operator}  (from ${resolved.source})`,
      notes:
        resolved.source === 'LP_OPERATOR_PRIVATE_KEY'
          ? ['Derived from the key in the environment. The key itself was not printed and never will be.']
          : undefined,
    });

    const balance = await safeRead(() => publicClient.getBalance({ address: operator! }));
    if (balance.ok) {
      const wei = balance.value;
      operatorChecks.push({
        status: wei === 0n ? 'fail' : wei < MIN_OPERATOR_GAS_WEI ? 'warn' : 'pass',
        label: 'Operator gas',
        detail: `${viemFormatEther(wei)} ETH  (${wei} wei)`,
        notes:
          wei === 0n
            ? ['Zero balance. The operator pays its own gas — it cannot execute anything until funded.']
            : wei < MIN_OPERATOR_GAS_WEI
              ? [`Below ${formatEther(MIN_OPERATOR_GAS_WEI)} ETH. Top it up before arming.`]
              : undefined,
      });
    } else {
      operatorChecks.push({ status: 'fail', label: 'Operator gas', detail: balance.error });
    }

    // The single most important relationship in the whole design.
    if (safeOwners.length > 0) {
      const isOwner = safeOwners.some((o) => sameAddress(o, operator!));
      operatorChecks.push({
        status: isOwner ? 'fail' : 'pass',
        label: 'Operator is NOT a Safe owner',
        detail: isOwner ? 'THE OPERATOR IS A SAFE OWNER. This breaks the entire security model.' : 'confirmed',
        notes: isOwner
          ? [
              'A hot key that is also a Safe owner can sign Safe transactions directly, which means it can',
              'disable the module, widen its own caps, or move everything. The module becomes decorative.',
              'Remove this key from the Safe owner set before going any further (plan §4).',
            ]
          : undefined,
      });
    } else {
      operatorChecks.push({
        status: 'skip',
        label: 'Operator is NOT a Safe owner',
        detail: 'could not check — Safe owners unknown',
      });
    }
  } catch (err) {
    operatorChecks.push({
      status: 'skip',
      label: 'Operator address',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  print(renderChecks(operatorChecks, { color }));
  results.push(...operatorChecks);

  // -------------------------------------------------------- Krystal destinations
  print(heading('5. Krystal destinations (the module allowlist targets)'));
  const destChecks: CheckResult[] = [];

  for (const dest of ROBINHOOD_ALLOWLIST) {
    const size = await safeRead(() => hasCode(publicClient, dest.address));
    destChecks.push(
      size.ok
        ? {
            status: size.value > 0 ? 'pass' : 'fail',
            label: dest.name,
            detail:
              size.value > 0
                ? `${dest.address}  (${size.value} bytes)`
                : `${dest.address} — NO CODE. Do NOT allowlist an address with no code.`,
            notes: dest.selectors.map((s) => `selector ${s}  ${dest.selectorPurpose[s] ?? ''}`),
          }
        : { status: 'fail', label: dest.name, detail: `${dest.address} — ${size.error}` },
    );
  }

  print(renderChecks(destChecks, { color }));
  results.push(...destChecks);

  // --------------------------------------------------------------------- module
  print(heading('6. OctAutomationModule (optional at this stage)'));
  const moduleRaw = args.values.get('module') ?? optionalEnv('LP_MODULE_ADDRESS');
  const moduleChecks: CheckResult[] = [];

  if (moduleRaw === undefined) {
    moduleChecks.push({
      status: 'skip',
      label: 'LP_MODULE_ADDRESS',
      detail: 'not set — the module has not been deployed yet.',
      notes: ['Expected before step 3. Run scripts/deployModule.ts when the sections above are green.'],
    });
  } else {
    const moduleAddress = requireAddress(moduleRaw, 'LP_MODULE_ADDRESS');
    const size = await safeRead(() => hasCode(publicClient, moduleAddress));
    if (size.ok && size.value > 0) {
      moduleChecks.push({ status: 'pass', label: 'Module contract', detail: `${moduleAddress}  (${size.value} bytes)` });

      const boundSafe = await safeRead(() =>
        publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'safe' }),
      );
      if (boundSafe.ok) {
        const matches = safeAddress !== null && sameAddress(boundSafe.value, safeAddress);
        moduleChecks.push({
          status: safeAddress === null ? 'info' : matches ? 'pass' : 'fail',
          label: 'module.safe()',
          detail: `${boundSafe.value}`,
          notes:
            safeAddress !== null && !matches
              ? [
                  `Does NOT match LP_SAFE_ADDRESS ${safeAddress}.`,
                  '`safe` is immutable in the module — this module can never be pointed at your Safe.',
                  'You are looking at the wrong module, or it was deployed with the wrong constructor arg.',
                ]
              : undefined,
        });
      } else {
        moduleChecks.push({ status: 'fail', label: 'module.safe()', detail: boundSafe.error });
      }

      const enabled = await safeRead(() =>
        publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'isModuleEnabledOnSafe' }),
      );
      moduleChecks.push(
        enabled.ok
          ? {
              status: enabled.value ? 'pass' : 'warn',
              label: 'Enabled on the Safe',
              detail: enabled.value ? 'yes' : 'no — an owner still has to sign safe.enableModule(module)',
            }
          : { status: 'warn', label: 'Enabled on the Safe', detail: enabled.error },
      );

      const paused = await safeRead(() =>
        publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'paused' }),
      );
      moduleChecks.push(
        paused.ok
          ? { status: 'info', label: 'Paused', detail: paused.value ? 'YES — operator execution is halted' : 'no' }
          : { status: 'warn', label: 'Paused', detail: paused.error },
      );

      for (const [label, fn] of [
        ['maxValuePerTx', 'maxValuePerTx'],
        ['dailyValueCap', 'dailyValueCap'],
        ['remainingDailyAllowance', 'remainingDailyAllowance'],
      ] as const) {
        const value = await safeRead(() =>
          publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: fn }),
        );
        moduleChecks.push(
          value.ok
            ? { status: 'info', label, detail: `${value.value} wei  (${formatEther(value.value as bigint)} ETH)` }
            : { status: 'warn', label, detail: value.error },
        );
      }
    } else if (size.ok) {
      moduleChecks.push({
        status: 'fail',
        label: 'Module contract',
        detail: `${moduleAddress} — NO CODE AT THIS ADDRESS.`,
      });
    } else {
      moduleChecks.push({ status: 'fail', label: 'Module contract', detail: `${moduleAddress} — ${size.error}` });
    }
  }

  print(renderChecks(moduleChecks, { color }));
  results.push(...moduleChecks);

  // -------------------------------------------------------------------- verdict
  const t = tally(results);
  print(banner(renderVerdict(t, 'The setup')));
  print(`  pass ${t.pass} · fail ${t.fail} · warn ${t.warn} · skipped ${t.skip} · info ${t.info}`);
  print(`  Explorer: ${BLOCK_EXPLORER}`);
  print('  Nothing was sent. This script cannot send anything.\n');

  return t.ok ? EXIT_OK : EXIT_FAILED_CHECK;
}

await runScript('preflight', main);
