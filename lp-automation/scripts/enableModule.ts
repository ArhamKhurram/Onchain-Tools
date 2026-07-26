#!/usr/bin/env tsx
//
// enableModule.ts — produces the owner-signed transaction that turns the module
// on. IT CANNOT SIGN OR SEND IT, and that is not a limitation to work around.
//
// Plan §9 point 3: the Safe owner key is a second wallet you hold, deliberately
// kept away from this automation. It exists precisely so the automation — or
// anyone who compromises it — can never widen its own limits. A script that
// could sign owner transactions would erase that boundary, so this one has no
// `--broadcast` flag, constructs no wallet client, and reads no private key.
//
// What it does: prints a `to` / `value` / `data` triple for you to execute in
// the Safe UI or your own wallet, and runs the read-only checks that catch the
// mistakes worth catching BEFORE the signature.
//
// Run:  npx tsx scripts/enableModule.ts

import type { Address } from 'viem';
import { MODULE_ABI, SAFE_ABI } from './lib/abi.js';
import { ArgError, findPrivateKeyLikeArgs, parseArgs, parseInteger, redactRpcUrl, requireAddress, sameAddress } from './lib/args.js';
import { assertChainId, buildPublicClient, hasCode } from './lib/client.js';
import { EXIT_FAILED_CHECK, EXIT_OK, print, runScript, wantsHelp } from './lib/cli.js';
import { EXPECTED_CHAIN_ID, PUBLIC_RPC_URL, SAFE_UI_BASE, SENTINEL_MODULES } from './lib/constants.js';
import { loadEnv, optionalEnv } from './lib/env.js';
import { buildDisableModulePayload, buildEnableModulePayload, renderPayload } from './lib/plan.js';
import { banner, heading, wrap } from './lib/report.js';

const HELP = `
enableModule.ts — emit the owner-signed safe.enableModule(module) transaction

  npx tsx scripts/enableModule.ts [flags]

THIS SCRIPT CANNOT BROADCAST. It holds no key and builds no wallet client. It
prints a transaction payload for you to execute with the OFFLINE Safe owner key.

Flags
  --safe <0x...>      Override LP_SAFE_ADDRESS.
  --module <0x...>    Override LP_MODULE_ADDRESS.
  --rpc-url <url>     Override LP_RPC_URL.
  --allow-chain <id>  Accept a chain id other than ${EXPECTED_CHAIN_ID}.
  --help              This text.

How to execute the payload
  Safe UI: ${SAFE_UI_BASE} -> your Safe -> New transaction -> Transaction Builder,
  paste the "to", "value" and "data" below verbatim, then collect the signatures
  your threshold requires.

  Verify on the signing device that the destination is YOUR SAFE and the data
  ends in the module address you deployed. A hardware wallet showing a different
  address than the one printed here means something is wrong between the two.
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
        'use one. Whatever you just pasted is in your shell history now — rotate it.',
    );
  }

  loadEnv();
  const args = parseArgs(argv);
  const allowChain = parseInteger(args.values.get('allow-chain'), '--allow-chain');

  const safeAddress = requireAddress(
    args.values.get('safe') ?? optionalEnv('LP_SAFE_ADDRESS'),
    'LP_SAFE_ADDRESS (or --safe)',
  ) as Address;
  const moduleAddress = requireAddress(
    args.values.get('module') ?? optionalEnv('LP_MODULE_ADDRESS'),
    'LP_MODULE_ADDRESS (or --module)',
  ) as Address;

  if (sameAddress(safeAddress, moduleAddress)) {
    throw new ArgError('The Safe address and the module address are the same. One of them is wrong.');
  }

  const rpcUrlRaw = args.values.get('rpc-url') ?? optionalEnv('LP_RPC_URL') ?? PUBLIC_RPC_URL;
  const { publicClient, rpcUrl } = buildPublicClient(rpcUrlRaw);
  const { chainId, note } = await assertChainId(publicClient, allowChain);

  print(banner('ENABLE MODULE — owner-signed transaction payload'));
  print(`  chain id  ${chainId}${note === undefined ? '' : `   (${note})`}`);
  print(`  rpc       ${redactRpcUrl(rpcUrl)}`);
  print(`  safe      ${safeAddress}`);
  print(`  module    ${moduleAddress}`);

  // --- pre-signature checks -------------------------------------------------
  print(heading('Checks before you sign'));
  let blocking = 0;

  const safeCode = await hasCode(publicClient, safeAddress);
  if (safeCode === 0) {
    print(`  FAIL  Safe ${safeAddress} has no code on chain ${chainId}.`);
    blocking += 1;
  } else {
    print(`  PASS  Safe exists (${safeCode} bytes)`);
  }

  const moduleCode = await hasCode(publicClient, moduleAddress);
  if (moduleCode === 0) {
    print(`  FAIL  Module ${moduleAddress} has no code on chain ${chainId}.`);
    print('        Enabling a module with no code would be a no-op today and a live backdoor the day');
    print('        someone deploys to that address via CREATE2. Do not sign it.');
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
      if (sameAddress(boundSafe, safeAddress)) {
        print(`  PASS  module.safe() == ${boundSafe}`);
      } else {
        print(`  FAIL  module.safe() is ${boundSafe}, not ${safeAddress}.`);
        print('        `safe` is immutable. This module can never be administered by your Safe — enabling');
        print('        it would give a module you do not control the ability to move your funds.');
        blocking += 1;
      }
    } catch (err) {
      print(`  FAIL  Could not read module.safe(): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      print('        The address has code but does not look like an OctAutomationModule.');
      blocking += 1;
    }
  }

  let alreadyEnabled = false;
  try {
    alreadyEnabled = (await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: 'isModuleEnabled',
      args: [moduleAddress],
    })) as boolean;
    print(
      alreadyEnabled
        ? '  info  The module is ALREADY enabled on this Safe. The payload below is a harmless no-op.'
        : '  PASS  Not yet enabled — this transaction is the one that enables it.',
    );
  } catch {
    print('  WARN  Could not read safe.isModuleEnabled(); continuing.');
  }

  try {
    const [existing] = (await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: 'getModulesPaginated',
      args: [SENTINEL_MODULES, 20n],
    })) as [readonly Address[], Address];
    const others = existing.filter((m) => !sameAddress(m, moduleAddress));
    if (others.length > 0) {
      print(`  WARN  This Safe already has ${others.length} other module(s) enabled:`);
      for (const m of others) print(`          ${m}`);
      print('        Every enabled module can move funds out of this Safe independently. If you did not');
      print('        add these deliberately, stop and investigate before adding another.');
    } else {
      print('  PASS  No unexpected modules already enabled');
    }
  } catch {
    print('  WARN  Could not enumerate existing modules.');
  }

  if (blocking > 0) {
    print(banner(`REFUSING TO EMIT A PAYLOAD — ${blocking} blocking problem(s) above`));
    print('  Fix them and re-run. A payload printed here would only be a payload you should not sign.\n');
    return EXIT_FAILED_CHECK;
  }

  // --- the payload ----------------------------------------------------------
  const payload = buildEnableModulePayload(safeAddress, moduleAddress);
  print(heading('Transaction to sign with the OFFLINE Safe owner key'));
  print('');
  print(renderPayload(payload, 0, 1));
  print('');

  print(heading('What this grants'));
  print(
    wrap(
      'Once executed, the module may call execTransactionFromModule on this Safe without any owner ' +
        'signature. Its authority is bounded only by its own allowlists and caps — which are currently ' +
        'EMPTY, so it can execute nothing until seedAllowlist.ts payloads are signed. That ordering is ' +
        'the point: enabling is safe precisely because the module is inert.',
      92,
      '  ',
    ),
  );

  print(heading('The kill switch, for reference'));
  print('  Keep this where you can find it under pressure. It removes the module entirely and does not');
  print("  depend on OctAutomationModule being correct — it is handled by Safe's own audited code.");
  print('');
  print(renderPayload(buildDisableModulePayload(safeAddress, SENTINEL_MODULES, moduleAddress), 0, 1));
  print('');
  print(`  NOTE: prevModule above is the sentinel ${SENTINEL_MODULES}, which is only correct while this`);
  print('  module is the FIRST entry in the Safe\'s module list. If other modules are added later, read the');
  print('  real predecessor from getModulesPaginated and re-encode. Signing a disableModule with the wrong');
  print('  prevModule reverts — it does not remove the wrong module — so this is a nuisance, not a hazard.');

  print(heading('After it executes'));
  print('  npx tsx scripts/seedAllowlist.ts    (the module is still inert until those 5 payloads land)');
  print('');

  return EXIT_OK;
}

await runScript('enableModule', main);
