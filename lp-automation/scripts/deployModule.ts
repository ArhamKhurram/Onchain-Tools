#!/usr/bin/env tsx
//
// deployModule.ts — deploys OctAutomationModule. THIS SPENDS REAL GAS.
//
// It is the only script in this directory that can broadcast, and it does not
// broadcast unless BOTH of these are true:
//
//   1. `--broadcast` was passed explicitly, and
//   2. the human typed the Safe address in full at an interactive prompt.
//
// The confirmation phrase is the Safe address on purpose. `y/n` is a reflex;
// typing 42 characters is not, and it forces a re-read of the one constructor
// argument that is IMMUTABLE after deployment. If `safe` is wrong, the module is
// scrap — there is no setSafe.
//
// Deploying does not arm anything. A freshly deployed module has no operators,
// no allowlisted targets and no allowlisted selectors: it can execute nothing at
// all, even if it were somehow enabled on the Safe. Arming is steps 4-7.
//
// Run:
//   npx tsx scripts/deployModule.ts --max-value-eth 0.01 --daily-cap-eth 0.05
//   npx tsx scripts/deployModule.ts --max-value-eth 0.01 --daily-cap-eth 0.05 --broadcast

import { encodeDeployData, formatEther as viemFormatEther, type Address } from 'viem';
import { MODULE_ABI, SAFE_ABI } from './lib/abi.js';
import {
  ArgError,
  checkCaps,
  findPrivateKeyLikeArgs,
  formatEther,
  parseAmount,
  parseArgs,
  parseInteger,
  redactRpcUrl,
  requireAddress,
  sameAddress,
} from './lib/args.js';
import { loadModuleArtifact, DEFAULT_ARTIFACT_PATH } from './lib/artifact.js';
import { assertChainId, buildPublicClient, buildWalletClient, hasCode } from './lib/client.js';
import { EXIT_FAILED_CHECK, EXIT_OK, print, printErr, runScript, wantsHelp } from './lib/cli.js';
import { checkBroadcastFlags, requireTypedConfirmation } from './lib/confirm.js';
import { BLOCK_EXPLORER, EXPECTED_CHAIN_ID, PUBLIC_RPC_URL } from './lib/constants.js';
import { loadAccountFromEnv, loadEnv, optionalEnv } from './lib/env.js';
import { banner, heading, wrap } from './lib/report.js';

const HELP = `
deployModule.ts — deploy OctAutomationModule to chain ${EXPECTED_CHAIN_ID}

  npx tsx scripts/deployModule.ts --max-value-eth <n> --daily-cap-eth <n> [--broadcast]

DRY RUN BY DEFAULT. Without --broadcast this prints exactly what it would do and
sends nothing. With --broadcast it still requires you to type the Safe address.

Caps (give each in EITHER ether OR wei, never both)
  --max-value-eth <n> / --max-value-wei <n>    Per-transaction native value cap.
  --daily-cap-eth <n> / --daily-cap-wei <n>    Per-UTC-day cumulative native cap.

Other flags
  --safe <0x...>        Override LP_SAFE_ADDRESS. IMMUTABLE once deployed.
  --rpc-url <url>       Override LP_RPC_URL.
  --artifact <path>     Forge artifact. Default:
                        ${DEFAULT_ARTIFACT_PATH}
  --allow-chain <id>    Accept a chain id other than ${EXPECTED_CHAIN_ID}.
  --broadcast           Actually send the deployment transaction.
  --help                This text.

Signing key
  LP_DEPLOYER_PRIVATE_KEY, or LP_OPERATOR_PRIVATE_KEY as a fallback.
  Read from the environment only — there is no key flag, and passing a key-shaped
  value on argv is refused. The deployer gets NO privileges over the module: the
  module's only administrator is the Safe, set in the constructor. Deploying from
  the operator key is therefore safe, just untidy.

Before you run this
  1. cd lp-automation/contracts && forge build && forge test -vvv    (green, not "written to pass")
  2. npx tsx scripts/preflight.ts                                     (all green)

Sizing the caps
  Start at dust. contracts/README.md §5 step 9: run the whole lifecycle with
  near-zero caps first, then raise them with an owner-signed setDailyValueCap.
  Raising a cap costs one signature. Walking back a loss costs the loss.
  And remember the fixed UTC-day bucket: up to 2x the daily cap can leave in one
  burst straddling midnight UTC.
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
      `Argument #${leaked[0]! + 1} looks like a private key. Keys are read from the environment only. ` +
        'That value is now in your shell history — treat the key as compromised and rotate it.',
    );
  }

  loadEnv();
  const args = parseArgs(argv);
  const allowChain = parseInteger(args.values.get('allow-chain'), '--allow-chain');

  // --- constructor arguments ------------------------------------------------
  const safeAddress = requireAddress(
    args.values.get('safe') ?? optionalEnv('LP_SAFE_ADDRESS'),
    'LP_SAFE_ADDRESS (or --safe)',
  ) as Address;

  const maxValuePerTx = parseAmount(
    { wei: args.values.get('max-value-wei'), eth: args.values.get('max-value-eth') },
    'maxValuePerTx',
  );
  const dailyValueCap = parseAmount(
    { wei: args.values.get('daily-cap-wei'), eth: args.values.get('daily-cap-eth') },
    'dailyValueCap',
  );

  const caps = checkCaps(maxValuePerTx, dailyValueCap);
  if (caps.errors.length > 0) {
    throw new ArgError(`Constructor arguments rejected:\n  - ${caps.errors.join('\n  - ')}`);
  }

  // --- artifact -------------------------------------------------------------
  const artifact = await loadModuleArtifact(args.values.get('artifact'));

  // --- chain ----------------------------------------------------------------
  const rpcUrlRaw = args.values.get('rpc-url') ?? optionalEnv('LP_RPC_URL') ?? PUBLIC_RPC_URL;
  const { publicClient, rpcUrl } = buildPublicClient(rpcUrlRaw);
  const { chainId, note } = await assertChainId(publicClient, allowChain);

  const account = loadAccountFromEnv(
    optionalEnv('LP_DEPLOYER_PRIVATE_KEY') !== undefined ? 'LP_DEPLOYER_PRIVATE_KEY' : 'LP_OPERATOR_PRIVATE_KEY',
  );

  const deployData = encodeDeployData({
    abi: MODULE_ABI,
    bytecode: artifact.bytecode,
    args: [safeAddress, maxValuePerTx, dailyValueCap],
  });

  // --- what we are about to do ---------------------------------------------
  print(banner('DEPLOY OctAutomationModule'));

  print(heading('Constructor arguments (read every line)'));
  print(`  safe            ${safeAddress}`);
  print(`                  ^ IMMUTABLE. The only address that can ever administer this module.`);
  print(`  maxValuePerTx   ${maxValuePerTx} wei   = ${formatEther(maxValuePerTx)} ETH`);
  print(`  dailyValueCap   ${dailyValueCap} wei   = ${formatEther(dailyValueCap)} ETH`);
  print(`                  ^ up to ${formatEther(dailyValueCap * 2n)} ETH can leave in one burst across midnight UTC`);

  for (const warning of caps.warnings) {
    print(`\n  WARN  ${wrap(warning, 92, '').replace(/\n/g, '\n        ')}`);
  }

  print(heading('Target'));
  print(`  chain id        ${chainId}${note === undefined ? '' : `   (${note})`}`);
  print(`  rpc             ${redactRpcUrl(rpcUrl)}`);
  print(`  deployer        ${account.address}`);
  print(`  artifact        ${artifact.path}`);
  print(`  bytecode        ${artifact.bytecodeLength} bytes`);
  print(
    `  compiler        solc ${artifact.compiler.version ?? '?'} · evm ${artifact.compiler.evmVersion ?? '?'} · optimizer ${artifact.compiler.optimizer ?? '?'}`,
  );
  for (const w of artifact.warnings) print(`  WARN            ${w}`);

  // --- sanity checks against chain state ------------------------------------
  print(heading('Pre-deploy checks'));
  let blocking = 0;

  const safeCode = await hasCode(publicClient, safeAddress);
  if (safeCode === 0) {
    print(`  FAIL  Safe ${safeAddress} has NO CODE on chain ${chainId}.`);
    print('        The module would be permanently bound to an address that is not a Safe.');
    blocking += 1;
  } else {
    print(`  PASS  Safe ${safeAddress} exists (${safeCode} bytes)`);
    try {
      const owners = (await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: 'getOwners',
      })) as readonly Address[];
      if (owners.some((o) => sameAddress(o, account.address))) {
        print(`  FAIL  The deployer key ${account.address} is a Safe OWNER.`);
        print('        If this is also the intended operator key, the module gives you nothing —');
        print('        an owner can disable it. Use a key that is not in the Safe owner set.');
        blocking += 1;
      } else {
        print(`  PASS  Deployer is not a Safe owner`);
      }
    } catch {
      print(`  WARN  Could not read the Safe's owner set; skipping the deployer-is-not-an-owner check.`);
    }
  }

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) {
    print(`  FAIL  Deployer ${account.address} has zero balance — the deployment cannot pay for gas.`);
    blocking += 1;
  } else {
    print(`  PASS  Deployer balance ${viemFormatEther(balance)} ETH`);
  }

  let gasEstimate: bigint | null = null;
  try {
    gasEstimate = await publicClient.estimateGas({ account: account.address, data: deployData });
    print(`  PASS  Gas estimate ${gasEstimate} (the deployment does not revert against current state)`);
  } catch (err) {
    print(`  FAIL  Gas estimation reverted: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    print('        A deployment that cannot be estimated will not succeed. Do not force it.');
    blocking += 1;
  }

  // --- broadcast gate -------------------------------------------------------
  const gate = checkBroadcastFlags({
    broadcast: args.booleans.has('broadcast'),
    yes: args.booleans.has('yes'),
  });

  if (!gate.allowed) {
    print(banner(gate.reason));
    if (blocking > 0) {
      print(`  ${blocking} blocking problem(s) above would have stopped the broadcast anyway.\n`);
      return EXIT_FAILED_CHECK;
    }
    print('  Everything above checks out. To deploy for real, re-run the identical command with --broadcast.\n');
    return EXIT_OK;
  }

  if (blocking > 0) {
    printErr(`\nRefusing to broadcast: ${blocking} blocking problem(s) above. Fix them and re-run.\n`);
    return EXIT_FAILED_CHECK;
  }

  print(banner('THIS WILL SPEND REAL GAS ON CHAIN ' + String(chainId)));
  await requireTypedConfirmation({
    phrase: safeAddress,
    meaning:
      'To confirm, type the Safe address this module will be PERMANENTLY bound to.\n' +
      'It is immutable: there is no setSafe, and a module bound to the wrong Safe is scrap.',
  });

  // Re-assert the chain id AFTER the prompt. Time passed, and an RPC URL can be
  // a load balancer in front of more than one network.
  const recheck = await assertChainId(publicClient, allowChain);
  if (recheck.chainId !== chainId) {
    throw new ArgError(
      `Chain id changed from ${chainId} to ${recheck.chainId} between the check and the send. Aborting.`,
    );
  }

  const wallet = buildWalletClient(rpcUrl, account);
  print('\nBroadcasting...');
  const hash = await wallet.deployContract({
    abi: MODULE_ABI,
    bytecode: artifact.bytecode,
    args: [safeAddress, maxValuePerTx, dailyValueCap],
  });
  print(`  tx hash   ${hash}`);
  print(`  explorer  ${BLOCK_EXPLORER}/tx/${hash}`);
  print('  waiting for the receipt...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success' || receipt.contractAddress == null) {
    printErr(`\nDeployment FAILED. status=${receipt.status}. Nothing was deployed.\n`);
    return EXIT_FAILED_CHECK;
  }

  const moduleAddress = receipt.contractAddress;

  // --- read the deployed state back off chain, do not trust the local args --
  print(heading('Deployed — verifying against chain state'));
  const deployedCode = await hasCode(publicClient, moduleAddress);
  const [onChainSafe, onChainMax, onChainDaily, onChainPaused] = await Promise.all([
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'safe' }),
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'maxValuePerTx' }),
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'dailyValueCap' }),
    publicClient.readContract({ address: moduleAddress, abi: MODULE_ABI, functionName: 'paused' }),
  ]);

  const mismatch =
    !sameAddress(onChainSafe as string, safeAddress) ||
    (onChainMax as bigint) !== maxValuePerTx ||
    (onChainDaily as bigint) !== dailyValueCap;

  print(`  code           ${deployedCode} bytes`);
  print(`  safe()         ${onChainSafe}`);
  print(`  maxValuePerTx  ${onChainMax} wei`);
  print(`  dailyValueCap  ${onChainDaily} wei`);
  print(`  paused         ${onChainPaused}`);

  if (mismatch) {
    printErr('\n  FAIL  On-chain state does not match what you asked for. DO NOT ENABLE THIS MODULE.\n');
    return EXIT_FAILED_CHECK;
  }
  print('  PASS  On-chain state matches the arguments you confirmed.');

  print(banner('MODULE DEPLOYED'));
  print(`  address   ${moduleAddress}`);
  print(`  block     ${receipt.blockNumber}`);
  print(`  gas used  ${receipt.gasUsed}`);
  print(`  explorer  ${BLOCK_EXPLORER}/address/${moduleAddress}`);

  print(heading('It can currently do NOTHING'));
  print(
    wrap(
      'No operators, no allowlisted targets, no allowlisted selectors. That is deliberate — deploying ' +
        'and arming are two separate decisions with two separate moments to think. Every step below is ' +
        'an owner-signed Safe transaction, and this tooling cannot sign any of them.',
      92,
      '  ',
    ),
  );

  print(heading('Next steps, in this order'));
  print(`  1.  Record it:      LP_MODULE_ADDRESS=${moduleAddress}   in lp-automation/.env`);
  print(`  2.  Record the deploy block for later audits:  LP_MODULE_DEPLOY_BLOCK=${receipt.blockNumber}`);
  print('  3.  npx tsx scripts/enableModule.ts     -> emits safe.enableModule(module), sign it with the OFFLINE owner key');
  print('  4.  npx tsx scripts/seedAllowlist.ts    -> emits 5 payloads; sign them in the printed order');
  print('  5.  npx tsx scripts/verifySetup.ts      -> read-only audit; must be fully green before you arm anything');
  print('');

  return EXIT_OK;
}

await runScript('deployModule', main);
