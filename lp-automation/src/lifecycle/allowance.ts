// Pre-flight ERC-20 allowance for zap flows (enter / increase).
//
// Called from the lifecycle loop before Krystal calldata is built. If allowance
// is insufficient, broadcasts approve(MAX) through the same executor funnel.

import {
  buildErc20Approve,
  isApprovableToken,
  KRYSTAL_V3UTILS,
  readErc20Allowance,
  type Erc20ReadClient,
} from '../calldata/erc20Approve.js';
import type { PreparedTransaction } from '../calldata/types.js';
import type { Address, AutomationPolicy, Decision, LpPosition } from '../types.js';
import type { ActionExecutor } from './executor.js';
import type { ActionResult, Clock, IdFactory, Logger } from './types.js';

export interface EnsureAllowanceDeps {
  owner: Address;
  chainId: number;
  approvableTokens: readonly Address[];
  reader: Erc20ReadClient;
  executor: ActionExecutor;
  now: Clock;
  newId: IdFactory;
  logger: Logger;
  recordRefusal: (decision: Decision, refusal: { rule: string; reason: string }) => Promise<void>;
}

export type EnsureAllowanceResult =
  | { ok: true }
  | { ok: false; reason: string };

function approveDecision(
  position: LpPosition,
  policy: AutomationPolicy,
  token: Address,
  commandId: string,
): Decision {
  return {
    action: 'approve',
    rule: 'lifecycle.erc20_approve',
    reason: `allowance for ${token} to Krystal v3utils is below the zap amount; approving before continuing`,
    snapshot: {
      tokenId: position.tokenId,
      pool: position.pool.address,
      policyVersion: policy.version,
      tokenInAddress: token,
      commandId,
    },
  };
}

/**
 * Ensure the Safe has approved Krystal v3utils to spend at least `amountRequired`
 * of `token`. Broadcasts approve(MAX) when needed.
 */
export async function ensureErc20Allowance(
  deps: EnsureAllowanceDeps,
  params: {
    token: Address;
    amountRequired: bigint;
    position: LpPosition;
    policy: AutomationPolicy;
    commandId: string;
  },
): Promise<EnsureAllowanceResult> {
  const { token, amountRequired, position, policy, commandId } = params;

  if (!isApprovableToken(token, deps.approvableTokens)) {
    return {
      ok: false,
      reason:
        `token ${token} is not on the module's ERC-20 approve allowlist — ` +
        'run the WETH approve setup (see lp-automation README) or add the token via owner-signed module tx',
    };
  }

  let allowance: bigint;
  try {
    allowance = await readErc20Allowance(deps.reader, deps.owner, token, KRYSTAL_V3UTILS);
  } catch (error) {
    const reason = `could not read ${token} allowance: ${describe(error)}`;
    await deps.recordRefusal(approveDecision(position, policy, token, commandId), {
      rule: 'lifecycle.allowance_read_failed',
      reason,
    });
    return { ok: false, reason };
  }

  if (allowance >= amountRequired) {
    return { ok: true };
  }

  deps.logger.info('lp-lifecycle: ERC-20 allowance below zap amount; broadcasting approve', {
    token,
    allowance: allowance.toString(),
    required: amountRequired.toString(),
    spender: KRYSTAL_V3UTILS,
  });

  const transaction: PreparedTransaction = buildErc20Approve(
    { chainId: deps.chainId, safe: deps.owner, builtAt: deps.now() },
    token,
    KRYSTAL_V3UTILS,
  );

  const decision = approveDecision(position, policy, token, commandId);
  const result = await deps.executor.execute({
    position,
    policy,
    decision,
    action: 'approve',
    transaction,
  });

  if (result.status === 'submitted' && result.recorded.error === null && result.recorded.txHash !== null) {
    return { ok: true };
  }

  const reason =
    result.status === 'refused' || result.status === 'simulation_failed'
      ? result.refusal.reason
      : result.status === 'intent_write_failed'
        ? result.error
        : result.status === 'outcome_write_failed'
          ? `approve broadcast uncertain: ${result.error}`
          : 'approve failed for an unknown reason';

  await deps.recordRefusal(decision, { rule: 'lifecycle.erc20_approve_failed', reason });
  return { ok: false, reason };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
