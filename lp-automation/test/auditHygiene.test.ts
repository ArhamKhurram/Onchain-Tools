import { describe, expect, it } from 'vitest';
import { buildOutcomeRecord, type AuditRecord } from '../src/audit/log.js';
import type { Decision } from '../src/types.js';
import {
  buildHygieneSidecar,
  hygieneSidecarPath,
  isReceiptConfirmedSnapshot,
  scanAuditHygiene,
  type ScanLine,
} from '../scripts/lib/auditHygiene.js';

const decision = (over: Partial<Decision> = {}): Decision => ({
  action: 'increase',
  rule: 'manual.increase',
  reason: 'manual increase',
  snapshot: {
    tokenId: '419551',
    amountIn: '10000000000000000',
    valueUsd: 60,
  },
  ...over,
});

const pending = (over: Partial<{ id: string; decision: Decision }> = {}) => ({
  id: 'audit-1',
  decision: decision(),
  startedAt: 1_700_000_000_000,
  ...over,
});

function successLine(
  over: Partial<AuditRecord> & { decision?: Decision } = {},
  lineNumber = 1,
): ScanLine {
  const basePending = pending(over.id ? { id: over.id } : {});
  const p = over.decision ? { ...basePending, decision: over.decision } : basePending;
  const snapshotOverride = over.snapshot;
  const record = buildOutcomeRecord(
    p,
    { txHash: over.txHash ?? '0xabc', error: over.error ?? null },
    over.timestamp ?? 1_700_000_005_000,
    snapshotOverride ? {} : { gasUsed: '500000', effectiveGasPriceWei: '1000000000' },
  );
  return {
    lineNumber,
    record: {
      ...record,
      ...over,
      snapshot: { ...record.snapshot, ...(snapshotOverride ?? {}) },
    },
  };
}

describe('isReceiptConfirmedSnapshot', () => {
  it('requires a positive gasUsed field', () => {
    expect(isReceiptConfirmedSnapshot({ gasUsed: '100' })).toBe(true);
    expect(isReceiptConfirmedSnapshot({ gasUsed: 0 })).toBe(false);
    expect(isReceiptConfirmedSnapshot({ gasSpentEstimated: true })).toBe(false);
  });
});

describe('scanAuditHygiene', () => {
  it('flags broadcast successes missing gasUsed', async () => {
    const report = await scanAuditHygiene({
      auditLogPath: 'audit.jsonl',
      lines: [
        successLine({
          snapshot: {
            tokenId: '419551',
            amountIn: '10000000000000000',
            valueUsd: 60,
            gasSpentUsd: 0.05,
            gasSpentEstimated: true,
          },
        }),
      ],
      now: () => '2026-07-27T00:00:00.000Z',
    });

    expect(report.clean).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.issues).toEqual(['missing_gas_used', 'false_success_increase']);
    expect(report.summary.missing_gas_used).toBe(1);
    expect(report.summary.false_success_increase).toBe(1);
  });

  it('ignores clean broadcast successes with receipt gas fields', async () => {
    const report = await scanAuditHygiene({
      auditLogPath: 'audit.jsonl',
      lines: [successLine()],
    });
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('ignores evaluation ticks and failures', async () => {
    const report = await scanAuditHygiene({
      auditLogPath: 'audit.jsonl',
      lines: [
        {
          lineNumber: 1,
          record: {
            id: 'eval-1',
            phase: 'success',
            timestamp: 1,
            action: 'none',
            rule: 'rebalance.in_range',
            reason: 'in range',
            snapshot: { tokenId: '1' },
            txHash: null,
            error: null,
          },
        },
        {
          lineNumber: 2,
          record: buildOutcomeRecord(pending(), { txHash: null, error: 'boom' }, 2),
        },
      ],
    });
    expect(report.clean).toBe(true);
  });

  it('flags reverted receipts logged as success', async () => {
    const report = await scanAuditHygiene({
      auditLogPath: 'audit.jsonl',
      lines: [
        successLine({
          decision: decision({ action: 'compound', rule: 'compound.fees_vs_gas' }),
        }),
      ],
      rpcChecked: true,
      lookupReceipt: async () => ({
        status: 'reverted',
        gasUsed: 120_000n,
        effectiveGasPrice: 1_000n,
      }),
    });

    expect(report.findings[0]?.issues).toContain('reverted_but_success');
    expect(report.findings[0]?.receiptStatus).toBe('reverted');
    expect(report.corrections[0]?.treatAsFailure).toBe(true);
  });

  it('suggests gas backfill when RPC confirms success but snapshot lacks gasUsed', async () => {
    const report = await scanAuditHygiene({
      auditLogPath: 'audit.jsonl',
      lines: [
        successLine({
          snapshot: {
            tokenId: '419551',
            amountIn: '10000000000000000',
            valueUsd: 60,
            gasSpentUsd: 0.05,
            gasSpentEstimated: true,
          },
        }),
      ],
      nativeTokenUsd: 2000,
      rpcChecked: true,
      lookupReceipt: async () => ({
        status: 'success',
        gasUsed: 500_000n,
        effectiveGasPrice: 1_000_000_000n,
      }),
    });

    expect(report.findings[0]?.issues).toEqual(['missing_gas_used', 'false_success_increase']);
    expect(report.corrections[0]?.snapshotOverride).toMatchObject({
      gasUsed: '500000',
      effectiveGasPriceWei: '1000000000',
      gasSpentEstimated: false,
    });
    expect(report.corrections[0]?.snapshotOverride.gasSpentUsd).toBeCloseTo(1, 5);
  });

  it('does not flag compound rows that only have estimated gas when RPC is unavailable', async () => {
    const report = await scanAuditHygiene({
      auditLogPath: 'audit.jsonl',
      lines: [
        successLine({
          decision: decision({ action: 'compound', rule: 'compound.fees_vs_gas' }),
          snapshot: {
            tokenId: '1',
            gasSpentUsd: 0.05,
            gasSpentEstimated: true,
          },
        }),
      ],
    });

    expect(report.findings[0]?.issues).toEqual(['missing_gas_used']);
    expect(report.findings[0]?.issues).not.toContain('false_success_increase');
  });
});

describe('hygiene sidecar helpers', () => {
  it('places the sidecar beside the audit log', () => {
    expect(hygieneSidecarPath('/data/audit.jsonl')).toBe('/data/audit.jsonl.hygiene.json');
  });

  it('wraps the report in a versioned sidecar envelope', async () => {
    const report = await scanAuditHygiene({
      auditLogPath: 'audit.jsonl',
      lines: [successLine({ snapshot: { tokenId: '1', gasSpentEstimated: true } })],
      now: () => '2026-07-27T00:00:00.000Z',
    });
    const sidecar = buildHygieneSidecar(report);
    expect(sidecar.version).toBe(1);
    expect(sidecar.sourceAuditLog).toBe('audit.jsonl');
    expect(sidecar.corrections).toHaveLength(1);
  });
});
