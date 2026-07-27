#!/usr/bin/env tsx
//
// seedAllowlist.ts — emits the five owner-signed transactions that arm the
// module. IT CANNOT SIGN OR SEND THEM (plan §9 point 3, same as enableModule.ts).
//
// These five payloads are the whole security perimeter for the automation. After
// they execute, a hot key can move funds within their bounds without any human
// in the loop. Read every address in the output. All 40 hex characters of each.
//
//   1. setTargetAllowed(Krystal v3utils, true)
//   2. setTargetAllowed(Uniswap V3 NonfungiblePositionManager, true)
//   3. setSelectorsAllowed(v3utils, [swap_and_mint, swap_and_increase], true)
//   4. setSelectorsAllowed(positionManager, [safeTransferFrom], true)
//   5. setOperator(hot key, true)          <- LAST, deliberately
//
// The batch form `setSelectorsAllowed` is used rather than one call per selector
// specifically to reduce the number of owner signatures: 5 transactions instead
// of 6, and one fewer opportunity to sign the wrong thing.
//
// Run:  npm run tx:allowlist
//       npm run tx:allowlist -- --delta   (only missing targets/selectors; skips operator if armed)
//       npm run tx:allowlist -- --revoke  (the exact inverse plan)

import type { Address } from 'viem';
import { MODULE_ABI, SAFE_ABI } from './lib/abi.js';
import {
  ArgError,
  findPrivateKeyLikeArgs,
  parseArgs,
  parseInteger,
  redactRpcUrl,
  requireAddress,
  sameAddress,
} from './lib/args.js';
import { assertChainId, buildPublicClient, hasCode } from './lib/client.js';
import { EXIT_FAILED_CHECK, EXIT_OK, print, runScript, wantsHelp } from './lib/cli.js';
import {
  EXPECTED_CHAIN_ID,
  PUBLIC_RPC_URL,
  REFERENCE_CONTRACTS,
  ROBINHOOD_ALLOWLIST,
  SAFE_UI_BASE,
} from './lib/constants.js';
import { loadEnv, optionalEnv, resolveOperatorAddress } from './lib/env.js';
import {
  buildAllowlistPlan,
  buildSetPausedPayload,
  destinationsNeedingAllowlist,
  operatorNeedsAuthorization,
  renderPayload,
} from './lib/plan.js';
import { banner, heading, wrap } from './lib/report.js';

const HELP = `
seedAllowlist.ts — emit the owner-signed transactions that arm the module

  npm run tx:allowlist [-- flags]

THIS SCRIPT CANNOT BROADCAST. It holds no key. It prints owner-signed
transaction payloads for the OFFLINE Safe owner key to execute.

Flags
  --delta             Emit ONLY destinations not yet allowlisted on-chain.
                      Skips setOperator when the hot key is already armed.
                      Use this after adding WETH approve to the intended list.
  --module <0x...>    Override LP_MODULE_ADDRESS.
  --operator <0x...>  Override the operator address (else LP_OPERATOR_ADDRESS,
                      else derived from LP_OPERATOR_PRIVATE_KEY).
  --safe <0x...>      Override LP_SAFE_ADDRESS (used for cross-checks only).
  --rpc-url <url>     Override LP_RPC_URL.
  --allow-chain <id>  Accept a chain id other than ${EXPECTED_CHAIN_ID}.
  --revoke            Emit the exact inverse: every setter with allowed=false.
                      For decommissioning or key rotation.
  --help              This text.

Signing them
  The Safe UI Transaction Builder (${SAFE_UI_BASE}) can batch all five into a
  single Safe transaction, which means ONE signing ceremony instead of five. The
  batch is executed as a MultiSend delegatecall by the Safe itself — standard
  Safe behaviour, unrelated to this module, which never delegatecalls anything.

  If you sign them separately, keep the printed order. setOperator is last so
  there is never a window in which an authorized hot key faces a half-configured
  module. If you must sign out of order, leave the module paused until the last
  one lands.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    print(HELP);
    return EXIT_OK;
  }

  const leaked = findPrivateKeyLikeArgs(argv);
  if (leaked.length > 0) {
    throw new ArgError(
      `Argument #${leaked[0]! + 1} looks like a private key. This script does not want a key and cannot ` +
        'use one. Rotate whatever you just pasted.',
    );
  }

  loadEnv();
  const args = parseArgs(argv);
  const revoke = args.booleans.has('revoke');
  const delta = args.booleans.has('delta');
  const allowChain = parseInteger(args.values.get('allow-chain'), '--allow-chain');
  if (delta && revoke) {
    throw new ArgError('--delta and --revoke cannot be used together.');
  }

  const moduleAddress = requireAddress(
    args.values.get('module') ?? optionalEnv('LP_MODULE_ADDRESS'),
    'LP_MODULE_ADDRESS (or --module)',
  ) as Address;
  const operator = resolveOperatorAddress(args.values.get('operator')).address as Address;
  const safeAddress = args.values.get('safe') ?? optionalEnv('LP_SAFE_ADDRESS');

  if (sameAddress(operator, moduleAddress)) {
    throw new ArgError('The operator address and the module address are the same. setOperator would revert.');
  }
  if (safeAddress !== undefined && sameAddress(operator, safeAddress)) {
    throw new ArgError('The operator address is the Safe itself. setOperator rejects that (InvalidOperator).');
  }

  const rpcUrlRaw = args.values.get('rpc-url') ?? optionalEnv('LP_RPC_URL') ?? PUBLIC_RPC_URL;
  const { publicClient, rpcUrl } = buildPublicClient(rpcUrlRaw);
  const { chainId, note } = await assertChainId(publicClient, allowChain);

  print(banner(revoke ? 'REVOKE ALLOWLIST — owner-signed payloads' : 'SEED ALLOWLIST — owner-signed payloads'));
  print(`  chain id  ${chainId}${note === undefined ? '' : `   (${note})`}`);
  print(`  rpc       ${redactRpcUrl(rpcUrl)}`);
  print(`  module    ${moduleAddress}`);
  print(`  operator  ${operator}`);

  // --- pre-signature checks -------------------------------------------------
  print(heading('Checks before you sign'));
  let blocking = 0;

  const moduleCode = await hasCode(publicClient, moduleAddress);
  if (moduleCode === 0) {
    print(`  FAIL  Module ${moduleAddress} has no code on chain ${chainId}.`);
    blocking += 1;
  } else {
    print(`  PASS  Module exists (${moduleCode} bytes)`);
  }

  if (moduleCode > 0) {
    try {
      const boundSafe = (await publicClient.readContract({
        address: moduleAddress,
        abi: MODULE_ABI,
        functionName: 'safe',
      })) as Address;
      print(`  info  module.safe() = ${boundSafe}`);
      if (safeAddress !== undefined && !sameAddress(boundSafe, safeAddress)) {
        print(`  FAIL  That is not LP_SAFE_ADDRESS ${safeAddress.toLowerCase()}.`);
        print('        These payloads would have to be signed by a Safe you are not looking at.');
        blocking += 1;
      }
      if (sameAddress(boundSafe, operator)) {
        print('  FAIL  The operator address IS the administering Safe. setOperator rejects this.');
        blocking += 1;
      }
    } catch (err) {
      print(`  FAIL  Could not read module.safe(): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      blocking += 1;
    }

    try {
      const enabled = (await publicClient.readContract({
        address: moduleAddress,
        abi: MODULE_ABI,
        functionName: 'isModuleEnabledOnSafe',
      })) as boolean;
      print(
        enabled
          ? '  PASS  Module is enabled on its Safe'
          : '  WARN  Module is NOT yet enabled on its Safe. These payloads still work (they configure the' +
            '\n        module, not the Safe), but nothing executes until enableModule.ts lands.',
      );
    } catch {
      print('  WARN  Could not read isModuleEnabledOnSafe().');
    }
  }

  // Destinations must have code. Allowlisting an address with no code is how a
  // CREATE2 pre-commitment becomes an authorized destination later.
  for (const dest of ROBINHOOD_ALLOWLIST) {
    const size = await hasCode(publicClient, dest.address);
    if (size === 0) {
      print(`  FAIL  ${dest.name} ${dest.address} has NO CODE on chain ${chainId}.`);
      print('        Refusing to emit an allowlist entry for an address with nothing deployed at it.');
      blocking += 1;
    } else {
      print(`  PASS  ${dest.name} ${dest.address} (${size} bytes)`);
    }
  }

  // The operator must not be a Safe owner. Checked here as well as in preflight
  // because this is the last script before the signature that makes it matter.
  if (safeAddress !== undefined) {
    try {
      const owners = (await publicClient.readContract({
        address: requireAddress(safeAddress, 'LP_SAFE_ADDRESS'),
        abi: SAFE_ABI,
        functionName: 'getOwners',
      })) as readonly Address[];
      if (owners.some((o) => sameAddress(o, operator))) {
        print(`  FAIL  Operator ${operator} is a Safe OWNER.`);
        print('        Authorizing it as an operator too would be pointless — as an owner it can already');
        print('        disable the module. Fix the owner set before arming anything (plan §4).');
        blocking += 1;
      } else {
        print('  PASS  Operator is not a Safe owner');
      }
    } catch {
      print('  WARN  Could not read the Safe owner set; the operator-is-not-an-owner check did not run.');
    }
  }

  if (blocking > 0 && !revoke) {
    print(banner(`REFUSING TO EMIT PAYLOADS — ${blocking} blocking problem(s) above`));
    print('  Fix them and re-run.\n');
    return EXIT_FAILED_CHECK;
  }

  // --- the payloads ---------------------------------------------------------
  let destinations = ROBINHOOD_ALLOWLIST;
  let includeOperator = true;
  if (delta && moduleCode > 0) {
    destinations = await destinationsNeedingAllowlist(publicClient, moduleAddress);
    includeOperator = await operatorNeedsAuthorization(publicClient, moduleAddress, operator);
    if (destinations.length === 0 && !includeOperator) {
      print(heading('Nothing to do'));
      print('  Every intended target, selector and operator is already configured on-chain.');
      print('  Run npm run verify:setup to audit the live state.\n');
      return EXIT_OK;
    }
    print(heading('Delta mode — missing on-chain entries only'));
    print(`  destinations to add  ${destinations.length}`);
    for (const dest of destinations) {
      print(`    - ${dest.name}  ${dest.address}`);
    }
    print(`  setOperator needed   ${includeOperator ? 'yes' : 'no (already armed)'}`);
    print('');
  }

  const payloads = buildAllowlistPlan({
    module: moduleAddress,
    operator,
    allowed: !revoke,
    destinations,
    includeOperator,
  });

  if (payloads.length === 0) {
    print(heading('Nothing to sign'));
    print('  No payloads were generated.\n');
    return EXIT_OK;
  }

  print(heading(`${payloads.length} transactions to sign with the OFFLINE Safe owner key, IN THIS ORDER`));
  print('');
  payloads.forEach((payload, i) => {
    print(renderPayload(payload, i, payloads.length));
    print('');
  });

  print(heading('The complete resulting permission set'));
  print(
    wrap(
      revoke
        ? 'After these execute the module can call nothing and has no authorized operator. It stays ' +
            'enabled on the Safe; use the disableModule payload from enableModule.ts to remove it entirely.'
        : 'After these execute, the hot key below may call exactly these functions on exactly these ' +
            'contracts, and nothing else, subject to the native-value caps set at deployment.',
      92,
      '  ',
    ),
  );
  print('');
  for (const dest of ROBINHOOD_ALLOWLIST) {
    print(`  ${dest.address}   ${dest.name}`);
    for (const sel of dest.selectors) {
      print(`      ${sel}   ${dest.selectorPurpose[sel] ?? ''}`);
    }
  }
  print(`  operator: ${operator}`);

  print(heading('What this does NOT constrain — read before signing'));
  print(
    wrap(
      'Argument-level intent is unchecked. Within an allowlisted selector the operator may pass hostile ' +
        'slippage, a hostile recipient, a hostile tick range or a hostile deadline. That is the realistic ' +
        'loss path here — not raw theft, but value destroyed through legitimate-looking calls ' +
        '(contracts/README.md §7 item 2).',
      92,
      '  ',
    ),
  );
  print('');
  print(
    wrap(
      'The caps bound NATIVE value only. ERC-20 amounts live inside calldata and are not capped on-chain. ' +
        'What actually bounds token exposure is how much approval the Safe has granted each allowlisted ' +
        'contract — grant tight, per-transaction approvals rather than infinite ones.',
      92,
      '  ',
    ),
  );
  print('');
  print(
    wrap(
      `Selector ${ROBINHOOD_ALLOWLIST[1]!.selectors[0]} on the position manager authorizes THREE operations ` +
        'at once (compound, adjust_range, withdraw_and_swap). They arrive as the same safeTransferFrom call ' +
        'and differ only in the trailing bytes argument, which the module does not decode. There is no way ' +
        'to allow compounding without also allowing withdrawal.',
      92,
      '  ',
    ),
  );
  print('');
  print('  These addresses must NEVER be added to the allowlist:');
  print(`    ${REFERENCE_CONTRACTS.uniswapV3Factory}   Uniswap V3 factory (pool verification only)`);

  print(heading('Emergency halt, for reference'));
  print('  One owner-signed transaction stops every operator immediately, without touching the allowlist,');
  print('  the operator set, or the Safe. Send this first if something looks wrong; investigate after.');
  print('');
  print(renderPayload(buildSetPausedPayload(moduleAddress, true), 0, 1));

  print(heading('After they execute'));
  print('  npx tsx scripts/verifySetup.ts    — read it back off chain. Do not trust this script\'s output');
  print('                                      as evidence of what actually landed.');
  print('');

  return EXIT_OK;
}

await runScript('seedAllowlist', main);
