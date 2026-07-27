// Process entry point (LP_AUTOMATION_PLAN.md Â§10 step 5).
//
// Startup order, and why it is this order:
//
//   1. Load + validate config. Refuse to start on anything invalid, naming the
//      variable. A signer process that starts half-configured is a process that
//      will discover the problem at the worst possible moment.
//   2. Build the read-only collaborators (RPC client, Krystal, policy file,
//      audit log). None of these can spend anything.
//   3. Obtain the signer and print its ARM STATE as a single, unmissable line.
//      Someone reading the first screen of logs must be able to tell whether
//      this process can spend money without inferring it from anything.
//   4. Print the resolved policy version and allowlist size â€” the two numbers
//      that bound what it may do even when armed. An allowlist of 0 means it
//      can do nothing, and that should be visible rather than surprising.
//   5. Start the loop, then wait for a signal.
//
// This process has NO inbound network surface (see `README.md`). Do not add an
// HTTP listener, a health endpoint, or a socket. Outbound calls only.

import { pathToFileURL } from 'node:url';
import { createPublicClient, http, type PublicClient } from 'viem';
import { AuditLog } from './audit/log.js';
import { DEFAULT_APPROVABLE_TOKENS } from './calldata/erc20Approve.js';
import type { CalldataPolicy } from './calldata/types.js';
import { KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3, ROBINHOOD_UNISWAP_V3_TARGETS } from './calldata/validate.js';
import { ConfigError, loadConfig, type LpAutomationConfig } from './config.js';
import { createWebhookAlertDispatcher } from './alerts/dispatch.js';
import { KrystalClient } from './ingest/krystal/client.js';
import { UNISWAP_V3_POOL_ABI } from './ingest/rpc/abi.js';
import { defineRobinhoodChain } from './ingest/rpc/chain.js';
import { PoolWatcher } from './ingest/rpc/poolWatcher.js';
import { currentDefaultPolicy } from './policy/index.js';
import type { TransactionSigner } from './signer/types.js';
import {
  FilePolicySource,
  KrystalCalldataBuilder,
  KrystalPositionFeed,
  LifecycleLoop,
  type Logger,
} from './lifecycle/index.js';
import { parseMintedTokenIdFromLogs } from './lifecycle/lineage.js';
import { createSupabaseCommandSource } from './lifecycle/commandSource.js';
import { createSupabasePolicySource } from './lifecycle/supabasePolicySource.js';
import type { Address } from './types.js';

// --- logging ----------------------------------------------------------------

/** Structured line logger. JSON meta so log search can filter on a tokenId. */
function createLogger(): Logger {
  const emit =
    (level: 'info' | 'warn' | 'error') =>
    (message: string, meta?: Record<string, unknown>): void => {
      const line = `${new Date().toISOString()} [${level}] ${message}`;
      const suffix = meta === undefined ? '' : ` ${safeJson(meta)}`;
      console[level === 'info' ? 'log' : level](`${line}${suffix}`);
    };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner: unknown) =>
      typeof inner === 'bigint' ? inner.toString() : inner,
    );
  } catch {
    return String(value);
  }
}

// --- the signer seam --------------------------------------------------------

/**
 * Load the signer implementation.
 *
 * Late-bound ON PURPOSE. `src/lifecycle/` consumes only the `TransactionSigner`
 * interface from `signer/types.ts`, which is import-free, so nothing that
 * decides what to do can reach a wallet client by following a type import. This
 * function is the single place the concrete implementation is named, and it
 * validates the shape it got rather than trusting the module.
 *
 * The expected contract: `src/signer/index.ts` exports a zero-argument factory
 * â€” `createSignerFromEnv()`, `createSigner()`, or `createTransactionSigner()` â€”
 * returning (or resolving to) a `TransactionSigner`.
 */
async function loadSigner(): Promise<TransactionSigner> {
  // Non-literal specifier: the lifecycle process must compile and unit-test
  // without the signer module present.
  const specifier = './signer/index.js';
  let module: Record<string, unknown>;
  try {
    module = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `could not load the signer module (${specifier}): ${describe(error)}. ` +
        'It must export a zero-argument factory returning a TransactionSigner.',
    );
  }

  const factory =
    module.createSignerFromEnv ?? module.createSigner ?? module.createTransactionSigner;
  if (typeof factory !== 'function') {
    throw new Error(
      `${specifier} exports no recognized signer factory (createSignerFromEnv | createSigner | ` +
        'createTransactionSigner). The lifecycle loop requires one returning a TransactionSigner ' +
        '{ getStatus, simulate, submit }.',
    );
  }

  const signer = (await (factory as () => unknown | Promise<unknown>)()) as TransactionSigner;
  for (const method of ['getStatus', 'simulate', 'submit'] as const) {
    if (typeof signer?.[method] !== 'function') {
      throw new Error(`the signer returned by ${specifier} has no ${method}() â€” refusing to start`);
    }
  }
  return signer;
}

// --- wiring -----------------------------------------------------------------

export interface RunOptions {
  config?: LpAutomationConfig;
  signer?: TransactionSigner;
  logger?: Logger;
}

/**
 * Construct everything and start the loop. Returns the running loop so a caller
 * (or a signal handler) can stop it.
 */
export async function run(options: RunOptions = {}): Promise<LifecycleLoop> {
  const logger = options.logger ?? createLogger();
  const config = options.config ?? loadConfig();

  const chain = defineRobinhoodChain({ httpUrl: config.rpc.httpUrl, wsUrl: config.rpc.wsUrl });
  // A PUBLIC client: no account, cannot sign, cannot send. Used only to read
  // `slot0()` so positions carry an authoritative current tick (plan Â§3).
  const publicClient: PublicClient = createPublicClient({
    chain,
    transport: http(config.rpc.httpUrl),
    batch: { multicall: true },
  });
  const readTick = async (pool: Address): Promise<number> => {
    const slot0 = await publicClient.readContract({
      address: pool,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'slot0',
    });
    return slot0[1];
  };

  // Full pool state for an enter (Zap In): the live tick, the fee unit (which
  // maps to tick spacing), and the token pair. Same public client â€” read-only,
  // cannot sign. viem batches these into one multicall.
  const readPoolState = async (
    pool: Address,
  ): Promise<{ currentTick: number; feeUnits: number; token0: Address; token1: Address }> => {
    const [slot0, fee, token0, token1] = await Promise.all([
      publicClient.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0' }),
      publicClient.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'fee' }),
      publicClient.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0' }),
      publicClient.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'token1' }),
    ]);
    return {
      currentTick: slot0[1],
      feeUnits: Number(fee),
      token0: token0.toLowerCase() as Address,
      token1: token1.toLowerCase() as Address,
    };
  };

  const krystal = new KrystalClient(
    config.krystalBaseUrl === undefined ? {} : { baseUrl: config.krystalBaseUrl },
  );

  const calldataPolicy: CalldataPolicy = {
    chainId: config.chainId,
    platform: config.platform,
    // Mirrors â€” does not replace â€” the module's on-chain allowlist (plan Â§4).
    allowedTargets: ROBINHOOD_UNISWAP_V3_TARGETS,
    expectedFrom: config.safeAddress,
    maxValueWei: config.maxValueWei,
  };

  // Supabase is the policy source the DASHBOARD writes to (plan Â§9.1), so it
  // takes precedence: if it is configured, the UI is authoritative and a stale
  // local file must not quietly override it. Falls back to the file, then to
  // DEFAULT_POLICY â€” whose empty allowlist means "do nothing".
  const supabasePolicySource = createSupabasePolicySource(process.env, config.policyUserId);
  const policySource = supabasePolicySource ?? new FilePolicySource(config.policyFilePath, logger);
  const policySourceLabel = supabasePolicySource
    ? `Supabase (${config.policyUserId})`
    : (config.policyFilePath ?? 'DEFAULT_POLICY (no policy source configured)');
  // The dashboard's manual action queue (plan Â§9 point 1). Same Supabase
  // credentials as the policy source, and the same "configured or not at all"
  // rule. Note the direction: this process POLLS the queue. It still has no
  // inbound surface â€” do not add one.
  //
  // This is the only table this process writes to, and only its status/result
  // columns. Policy and settings stay read-only, exactly as Â§9.1 requires.
  const commandSource = createSupabaseCommandSource(process.env, config.policyUserId);

  const signer = options.signer ?? (await loadSigner());

  // --- the startup banner ---------------------------------------------------
  const status = await signer.getStatus();
  if (status.armState === 'armed') {
    logger.warn(
      '*** ARM STATE: ARMED â€” this process CAN broadcast transactions and spend real funds ***',
      {
        operator: status.operatorAddress,
        safe: status.safeAddress,
        module: status.moduleAddress,
        chainId: status.chainId,
        moduleEnabled: status.moduleEnabled,
        remainingDailyAllowanceWei: status.remainingDailyAllowanceWei,
      },
    );
  } else {
    logger.info(
      '*** ARM STATE: DISARMED â€” this process will watch, evaluate, simulate and log, ' +
        'but CANNOT broadcast ***',
      { operator: status.operatorAddress, safe: status.safeAddress, chainId: status.chainId },
    );
  }
  if (!status.moduleEnabled) {
    logger.error(
      'the automation module is NOT enabled on the Safe â€” nothing can execute until it is',
      { safe: status.safeAddress, module: status.moduleAddress },
    );
  }
  if (status.safeAddress.toLowerCase() !== config.safeAddress) {
    // Krystal builds calldata FOR `LP_SAFE_ADDRESS`; the signer executes through
    // `status.safeAddress`. A mismatch means every transaction would be built
    // for an account that is not the one executing it.
    throw new ConfigError(
      `LP_SAFE_ADDRESS (${config.safeAddress}) does not match the Safe the signer is configured for ` +
        `(${status.safeAddress}). Refusing to start.`,
    );
  }

  const bundle = await policySource.load();
  const resolved = currentDefaultPolicy(bundle.policies);
  logger.info('lp-lifecycle: policy', {
    defaultVersion: resolved?.version ?? null,
    versions: bundle.policies.map((policy) => policy.version),
    allowlistedPools: resolved?.allowedPools.length ?? 0,
    pinnedPositions: Object.keys(bundle.bindings).length,
    source: policySourceLabel,
    manualCommands: commandSource === null ? 'disabled (no Supabase)' : 'enabled (polled)',
  });
  if ((resolved?.allowedPools.length ?? 0) === 0) {
    logger.warn(
      'the policy allowlist is EMPTY â€” no pool is approved, so no action can execute. ' +
        'This is the safe default; tick a pool in the dashboard to change it.',
    );
  }
  if (config.maxValueWei <= 0n) {
    logger.warn(
      'LP_MAX_TX_VALUE_WEI is zero â€” native ETH enter/increase zaps will be refused. ' +
        'Set it to match the Safe module maxValuePerTx cap when using native ETH.',
    );
  }

  if (config.alertWebhookUrl) {
    logger.info('lp-alerts: Discord webhook configured', {
      outOfRangeMinutes: config.alertOutOfRangeMinutes,
      gasThresholdUsd: config.alertGasThresholdUsd,
    });
  }

  const loop = new LifecycleLoop({
    policySource,
    positions: new KrystalPositionFeed({
      client: krystal,
      chainId: config.chainId,
      owner: config.safeAddress,
      readTick,
      logger,
    }),
    calldata: new KrystalCalldataBuilder({
      context: { policy: calldataPolicy, client: krystal },
      swapSlippage: config.swapSlippage,
      liquiditySlippage: config.liquiditySlippage,
    }),
    ...(commandSource === null ? {} : { commands: commandSource }),
    poolState: { readPoolState },
    allowance: {
      owner: config.safeAddress,
      chainId: config.chainId,
      approvableTokens: DEFAULT_APPROVABLE_TOKENS,
      reader: publicClient,
    },
    signer,
    audit: new AuditLog(config.auditLogPath),
    waitForReceipt: async (txHash) => {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash as `0x${string}`,
          timeout: 120_000,
        });
        if (receipt.status !== 'success') return { status: 'reverted' };
        const effectiveGasPrice =
          receipt.effectiveGasPrice ?? (await publicClient.getGasPrice());
        return { status: 'success', gasUsed: receipt.gasUsed, effectiveGasPrice };
      } catch {
        return null;
      }
    },
    nativeTokenUsd: config.nativeTokenUsd,
    extractRebalanceSuccessor: async (txHash) => {
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        if (receipt.status !== 'success') return null;
        return parseMintedTokenIdFromLogs(
          receipt.logs,
          KRYSTAL_TARGETS_ROBINHOOD_UNISWAP_V3.positionManager,
          config.safeAddress,
        );
      } catch {
        return null;
      }
    },
    createWatcher: (callbacks) => new PoolWatcher({ config: config.rpc, callbacks, logger }),
    logger,
    alerts: createWebhookAlertDispatcher({ webhookUrl: config.alertWebhookUrl }, logger),
    options: {
      positionPollIntervalMs: config.positionPollIntervalMs,
      commandPollIntervalMs: config.commandPollIntervalMs,
      calldataMaxAgeMs: config.calldataMaxAgeMs,
      rebalanceCalldataMaxAgeMs: config.rebalanceCalldataMaxAgeMs,
      gasCostUsd: config.gasCostUsd,
      alertOutOfRangeMinutes: config.alertOutOfRangeMinutes,
      alertGasThresholdUsd: config.alertGasThresholdUsd,
    },
  });

  await loop.start();
  return loop;
}

// --- process ----------------------------------------------------------------

async function main(): Promise<void> {
  const logger = createLogger();

  let loop: LifecycleLoop;
  try {
    loop = await run({ logger });
  } catch (error) {
    // Configuration problems are reported plainly and exit non-zero. They name
    // the variable (see `config.ts`) so the fix is unambiguous.
    if (error instanceof ConfigError) {
      logger.error(`refusing to start: ${error.message}`);
    } else {
      logger.error(`refusing to start: ${describe(error)}`);
    }
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      // A second signal from an impatient operator. Say what is being given up
      // rather than exiting silently â€” an abandoned in-flight action leaves an
      // unresolved intent that the next start will quarantine.
      logger.error(`${signal} received again â€” forcing exit; in-flight work is being abandoned`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.info(`${signal} received â€” shutting down`);
    loop
      .stop()
      .then(() => {
        // Clean shutdown is not a failure. Exit code stays 0.
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        logger.error(`shutdown failed: ${describe(error)}`);
        process.exitCode = 1;
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Only run when executed directly, so importing this module (tests, tooling)
// does not start a process that holds a key.
const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main();
}
