// Pure audit-log hygiene scan for the LP automation JSONL trail.
import type { AuditRecord } from '../../src/audit/log.js';

export const BROADCAST_ACTIONS = new Set([
  'enter',
  'increase',
  'approve',
  'compound',
  'rebalance',
  'exit',
]);

export type HygieneIssueKind =
  | 'missing_gas_used'
  | 'reverted_but_success'
  | 'false_success_increase';

export type ReceiptStatus = 'success' | 'reverted' | 'not_found' | 'unchecked';

export interface HygieneFinding {
  auditId: string;
  lineNumber: number;
  action: string;
  phase: string;
  txHash: string;
  timestamp: number;
  issues: HygieneIssueKind[];
  receiptStatus: ReceiptStatus;
  details: string | null;
}

export interface AuditCorrection {
  auditId: string;
  lineNumber: number;
  issues: HygieneIssueKind[];
  treatAsFailure: boolean;
  reason: string;
  snapshotOverride: Record<string, unknown>;
}

export interface HygieneReport {
  scannedAt: string;
  auditLogPath: string;
  recordCount: number;
  malformedLineCount: number;
  rpcChecked: boolean;
  summary: Record<HygieneIssueKind, number>;
  findings: HygieneFinding[];
  corrections: AuditCorrection[];
  clean: boolean;
}

export interface ScanLine {
  lineNumber: number;
  record: AuditRecord;
}

export type ReceiptLookup = (
  txHash: string,
) => Promise<{ status: 'success' | 'reverted'; gasUsed: bigint; effectiveGasPrice: bigint } | null>;

export interface ScanAuditHygieneOptions {
  auditLogPath: string;
  lines: readonly ScanLine[];
  malformedLineCount?: number;
  rpcChecked?: boolean;
  lookupReceipt?: ReceiptLookup;
  nativeTokenUsd?: number | null;
  now?: () => string;
}

export function isReceiptConfirmedSnapshot(snapshot: Record<string, unknown>): boolean {
  const gasUsed = snapshot.gasUsed;
  return gasUsed !== undefined && gasUsed !== null && gasUsed !== '' && gasUsed !== 0;
}

function isBroadcastSuccess(record: AuditRecord): record is AuditRecord & { txHash: string } {
  return (
    record.phase === 'success' &&
    record.error === null &&
    typeof record.txHash === 'string' &&
    record.txHash.length > 0 &&
    BROADCAST_ACTIONS.has(record.action)
  );
}

function emptySummary(): Record<HygieneIssueKind, number> {
  return {
    missing_gas_used: 0,
    reverted_but_success: 0,
    false_success_increase: 0,
  };
}

function addIssue(issues: HygieneIssueKind[], issue: HygieneIssueKind): HygieneIssueKind[] {
  return issues.includes(issue) ? issues : [...issues, issue];
}

function gasSpentUsdFromReceipt(
  gasUsed: bigint,
  effectiveGasPrice: bigint,
  nativeTokenUsd: number | null | undefined,
): number | undefined {
  if (nativeTokenUsd === null || nativeTokenUsd === undefined || !Number.isFinite(nativeTokenUsd) || nativeTokenUsd <= 0) {
    return undefined;
  }
  const wei = gasUsed * effectiveGasPrice;
  const eth = Number(wei) / 1e18;
  if (!Number.isFinite(eth)) return undefined;
  return eth * nativeTokenUsd;
}

function buildCorrection(
  finding: HygieneFinding,
  record: AuditRecord,
  receipt: { gasUsed: bigint; effectiveGasPrice: bigint } | null,
  nativeTokenUsd: number | null | undefined,
): AuditCorrection {
  const snapshotOverride: Record<string, unknown> = {};
  let treatAsFailure = false;
  let reason = finding.details ?? finding.issues.join(', ');

  if (finding.issues.includes('reverted_but_success')) {
    treatAsFailure = true;
    reason = `transaction reverted on chain (tx ${finding.txHash})`;
  } else if (finding.issues.includes('false_success_increase')) {
    treatAsFailure = true;
    reason =
      finding.receiptStatus === 'unchecked'
        ? 'increase logged as success without receipt-confirmed gasUsed'
        : `increase logged as success but receipt status is ${finding.receiptStatus}`;
  }

  if (finding.issues.includes('missing_gas_used') && receipt !== null) {
    snapshotOverride.gasUsed = receipt.gasUsed.toString();
    snapshotOverride.effectiveGasPriceWei = receipt.effectiveGasPrice.toString();
    const gasSpentUsd = gasSpentUsdFromReceipt(receipt.gasUsed, receipt.effectiveGasPrice, nativeTokenUsd);
    if (gasSpentUsd !== undefined) snapshotOverride.gasSpentUsd = gasSpentUsd;
    snapshotOverride.gasSpentEstimated = false;
    if (record.snapshot.nativeTokenUsd !== undefined) {
      snapshotOverride.nativeTokenUsd = record.snapshot.nativeTokenUsd;
    } else if (nativeTokenUsd !== null && nativeTokenUsd !== undefined) {
      snapshotOverride.nativeTokenUsd = nativeTokenUsd;
    }
  }

  return {
    auditId: finding.auditId,
    lineNumber: finding.lineNumber,
    issues: finding.issues,
    treatAsFailure,
    reason,
    snapshotOverride,
  };
}

export async function scanAuditHygiene(options: ScanAuditHygieneOptions): Promise<HygieneReport> {
  const summary = emptySummary();
  const findings: HygieneFinding[] = [];
  const corrections: AuditCorrection[] = [];
  const rpcChecked = options.rpcChecked ?? options.lookupReceipt !== undefined;
  const nativeTokenUsd = options.nativeTokenUsd ?? null;

  for (const { lineNumber, record } of options.lines) {
    if (!isBroadcastSuccess(record)) continue;

    let issues: HygieneIssueKind[] = [];
    let receiptStatus: ReceiptStatus = rpcChecked ? 'not_found' : 'unchecked';
    let details: string | null = null;
    let receipt:
      | { status: 'success' | 'reverted'; gasUsed: bigint; effectiveGasPrice: bigint }
      | null = null;

    const missingGas = !isReceiptConfirmedSnapshot(record.snapshot);
    if (missingGas) {
      issues = addIssue(issues, 'missing_gas_used');
      details = 'broadcast success is missing snapshot.gasUsed';
    }

    if (record.action === 'increase' && missingGas) {
      issues = addIssue(issues, 'false_success_increase');
    }

    if (options.lookupReceipt) {
      receipt = await options.lookupReceipt(record.txHash);
      if (receipt === null) {
        receiptStatus = 'not_found';
        if (missingGas) details = `${details ?? ''} (receipt not found on RPC)`.trim();
      } else {
        receiptStatus = receipt.status;
        if (receipt.status === 'reverted') {
          issues = addIssue(issues, 'reverted_but_success');
          if (record.action === 'increase') issues = addIssue(issues, 'false_success_increase');
          details = `receipt status is reverted for tx ${record.txHash}`;
        } else if (missingGas) {
          details = 'receipt confirms success but snapshot is missing gasUsed';
        }
      }
    }

    if (issues.length === 0) continue;

    const finding: HygieneFinding = {
      auditId: record.id,
      lineNumber,
      action: record.action,
      phase: record.phase,
      txHash: record.txHash,
      timestamp: record.timestamp,
      issues,
      receiptStatus,
      details,
    };
    findings.push(finding);
    for (const issue of issues) summary[issue] += 1;
    corrections.push(buildCorrection(finding, record, receipt, nativeTokenUsd));
  }

  return {
    scannedAt: (options.now ?? (() => new Date().toISOString()))(),
    auditLogPath: options.auditLogPath,
    recordCount: options.lines.length,
    malformedLineCount: options.malformedLineCount ?? 0,
    rpcChecked,
    summary,
    findings,
    corrections,
    clean: findings.length === 0,
  };
}

export function hygieneSidecarPath(auditLogPath: string): string {
  return `${auditLogPath}.hygiene.json`;
}

export interface HygieneSidecar {
  version: 1;
  sourceAuditLog: string;
  generatedAt: string;
  report: HygieneReport;
  corrections: AuditCorrection[];
}

export function buildHygieneSidecar(report: HygieneReport): HygieneSidecar {
  return {
    version: 1,
    sourceAuditLog: report.auditLogPath,
    generatedAt: report.scannedAt,
    report,
    corrections: report.corrections,
  };
}
