import { describe, expect, it, vi } from 'vitest';
import type { PendingAction } from '../src/audit/log.js';
import type { PreparedTransaction } from '../src/calldata/types.js';
import { DEFAULT_POLICY } from '../src/policy/index.js';
import type {
  SignerStatus,
  SubmitOutcome,
  SubmitRequest,
  TransactionSigner,
} from '../src/signer/types.js';
import { ActionExecutor, type TransactionReceiptInfo } from '../src/lifecycle/executor.js';
import { Quarantine } from '../src/lifecycle/unresolved.js';
import type { AuditPort, Logger } from '../src/lifecycle/types.js';
import type { Address, AutomationPolicy, Decision, LpPosition } from '../src/types.js';

const POOL = '0x69bfaf19d1f3f0c0a1b8f0a8a4c5d6e7f8091a2b' as Address;
const SAFE = '0x2222222222222222222222222222222222222222' as Address;
const TX_HASH = '0x0104b9f8a2fba119df32676093e7767c96ed29103446ae190b86806da4ac5949';
const NOW = 1_800_000_000_000;

function policy(): AutomationPolicy {
  return { ...DEFAULT_POLICY, allowedPools: [POOL] };
}

function position(): LpPosition {
  return {
    tokenId: '395774',
    pool: {
      address: POOL,
      chainId: 4663,
      platform: 'uniswapv3',
      feeTierBps: 10_000,
      token0: { address: SAFE, symbol: 'WETH', decimals: 18 },
      token1: { address: POOL, symbol: 'USDG', decimals: 6 },
      tvlUsd: 500_000,
      volume24hUsd: 100_000,
      feeApr: 0.4,
    },
    status: 'in_range',
    tickLower: 141_800,
    tickUpper: 148_800,
    currentTick: 145_000,
    valueUsd: 250,
    unclaimedFeesUsd: 5,
    openedAt: NOW - 3_600_000,
    lastCompoundedAt: NOW - 3_600_000,
  };
}

function preparedTransaction(builtAt = NOW): PreparedTransaction {
  return Object.freeze({
    to: '0x73991a25c818bf1f1128deaab1492d45638de0d3' as Address,
    value: 0n,
    data: '0xb88d4fde0000',
    meta: {
      kind: 'compound',
      chainId: 4663,
      platform: 'uniswapv3',
      from: SAFE,
      selector: '0xb88d4fde',
      estimateGas: null,
      gasLimit: null,
      usedDefaultGas: false,
      builtAt,
      txInfo: null,
    },
  }) as PreparedTransaction;
}

function decision(): Decision {
  return {
    action: 'compound',
    rule: 'manual.compound',
    reason: 'operator requested',
    snapshot: { tokenId: '395774', pool: POOL },
  };
}

class FakeSigner implements TransactionSigner {
  outcome: SubmitOutcome = { status: 'broadcast', txHash: TX_HASH };

  async getStatus(): Promise<SignerStatus> {
    return {
      armState: 'armed',
      operatorAddress: SAFE,
      safeAddress: SAFE,
      moduleAddress: SAFE,
      moduleEnabled: true,
      remainingDailyAllowanceWei: 10n ** 18n,
      chainId: 4663,
    };
  }

  async simulate(_request: SubmitRequest): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async submit(_request: SubmitRequest): Promise<SubmitOutcome> {
    return this.outcome;
  }
}

class FakeAudit implements AuditPort {
  readonly outcomes: {
    pending: PendingAction;
    txHash: string | null;
    error: string | null;
  }[] = [];

  async read() {
    return { records: [], malformed: [] };
  }

  async recordIntent(_pending: PendingAction): Promise<void> {}

  async recordOutcome(
    pending: PendingAction,
    outcome: { txHash: string | null; error: string | null },
  ): Promise<void> {
    this.outcomes.push({ pending, ...outcome });
  }

  async recordEvaluation(): Promise<void> {}
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function executor(
  over: {
    signer?: FakeSigner;
    audit?: FakeAudit;
    waitForReceipt?: (txHash: string) => Promise<TransactionReceiptInfo | null>;
  } = {},
) {
  const signer = over.signer ?? new FakeSigner();
  const audit = over.audit ?? new FakeAudit();
  return {
    executor: new ActionExecutor({
      audit,
      signer,
      logger: silentLogger,
      now: () => NOW,
      newId: () => 'audit-1',
      quarantine: () => Quarantine.empty(),
      calldataMaxAgeMs: 30_000,
      rebalanceCalldataMaxAgeMs: 15_000,
      waitForReceipt: over.waitForReceipt,
    }),
    signer,
    audit,
  };
}

describe('ActionExecutor receipt confirmation', () => {
  it('records done when broadcast is followed by a success receipt', async () => {
    const waitForReceipt = vi.fn(async () => ({
      status: 'success' as const,
      gasUsed: 120_000n,
      effectiveGasPrice: 1_000_000_000n,
    }));
    const { executor: actionExecutor, audit } = executor({ waitForReceipt });

    const result = await actionExecutor.execute({
      position: position(),
      policy: policy(),
      decision: decision(),
      action: 'compound',
      transaction: preparedTransaction(),
    });

    expect(result.status).toBe('submitted');
    if (result.status !== 'submitted') return;
    expect(result.recorded).toEqual({ txHash: TX_HASH, error: null });
    expect(audit.outcomes[0]).toEqual({
      pending: expect.objectContaining({ id: 'audit-1' }),
      txHash: TX_HASH,
      error: null,
    });
    expect(waitForReceipt).toHaveBeenCalledWith(TX_HASH);
  });

  it('records failed when broadcast is followed by a reverted receipt', async () => {
    const waitForReceipt = vi.fn(async () => ({ status: 'reverted' as const }));
    const { executor: actionExecutor, audit } = executor({ waitForReceipt });

    const result = await actionExecutor.execute({
      position: position(),
      policy: policy(),
      decision: decision(),
      action: 'increase',
      transaction: preparedTransaction(),
    });

    expect(result.status).toBe('submitted');
    if (result.status !== 'submitted') return;
    expect(result.recorded.error).toContain('reverted on chain');
    expect(result.recorded.error).toContain(TX_HASH);
    expect(result.recorded.txHash).toBe(TX_HASH);
    expect(audit.outcomes[0]?.error).toContain(TX_HASH);
  });

  it('records failed when the receipt never becomes available', async () => {
    const waitForReceipt = vi.fn(async () => null);
    const { executor: actionExecutor, audit } = executor({ waitForReceipt });

    const result = await actionExecutor.execute({
      position: position(),
      policy: policy(),
      decision: decision(),
      action: 'compound',
      transaction: preparedTransaction(),
    });

    expect(result.status).toBe('submitted');
    if (result.status !== 'submitted') return;
    expect(result.recorded.error).toContain('receipt unavailable after timeout');
    expect(result.recorded.error).toContain(TX_HASH);
    expect(audit.outcomes[0]?.txHash).toBe(TX_HASH);
    expect(audit.outcomes[0]?.error).toMatch(/timeout/);
  });
});

describe('calldata max age', () => {
  it('refuses rebalance calldata past the tighter rebalance limit', async () => {
    const { executor: actionExecutor } = executor();
    const result = await actionExecutor.execute({
      position: position(),
      policy: policy(),
      decision: decision(),
      action: 'rebalance',
      transaction: preparedTransaction(NOW - 20_000),
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.refusal.rule).toBe('lifecycle.calldata_stale');
    expect(result.refusal.reason).toContain('15000ms');
  });

  it('accepts compound calldata within the general limit but past the rebalance limit', async () => {
    const { executor: actionExecutor } = executor();
    const result = await actionExecutor.execute({
      position: position(),
      policy: policy(),
      decision: decision(),
      action: 'compound',
      transaction: preparedTransaction(NOW - 20_000),
    });
    expect(result.status).toBe('submitted');
  });
});
