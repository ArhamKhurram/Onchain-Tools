// Tax/accounting export rows derived from the LP automation audit log.
//
// Pure — no I/O. The backend reads JSONL via `auditReader` and maps successful
// on-chain outcomes into a flat ledger suitable for CSV import.

import type { AuditRecordLike } from './auditReader.js';
import { depositUsdFromSnapshot, gasSpentUsdFromSnapshot, type PnlDerivationOptions } from './pnl.js';

export interface LpTaxExportRow {
  timestamp: string;
  action: string;
  tokenId: string | null;
  pool: string | null;
  amountIn: string | null;
  depositValueUsd: number | null;
  gasSpentUsd: number | null;
  valueUsd: number | null;
  txHash: string | null;
}

const EXPORT_ACTIONS = new Set(['enter', 'increase', 'compound', 'rebalance', 'exit', 'approve']);

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTokenId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim().replace(/^#/, '');
  return text === '' ? null : text;
}

function normalizePool(snapshot: Record<string, unknown>): string | null {
  const raw = snapshot.pool ?? snapshot.poolAddress;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? text : null;
}

function formatAmountIn(snapshot: Record<string, unknown>): string | null {
  const raw = snapshot.amountIn;
  if (raw === undefined || raw === null) return null;
  return String(raw);
}

function isExportableRecord(record: AuditRecordLike): boolean {
  if (record.phase === 'intent') return false;
  if (record.action === 'none') return false;
  if (!EXPORT_ACTIONS.has(record.action)) return false;
  return record.phase === 'success' && record.error === null;
}

function depositValueForRow(
  record: AuditRecordLike,
  snapshot: Record<string, unknown>,
  options: PnlDerivationOptions,
): number | null {
  if (record.action === 'enter' || record.action === 'increase') {
    return depositUsdFromSnapshot(snapshot, options);
  }
  return finite(snapshot.depositValueUsd);
}

export function buildTaxExportRows(
  records: readonly AuditRecordLike[],
  options: PnlDerivationOptions = {},
): LpTaxExportRow[] {
  const rows: LpTaxExportRow[] = [];
  for (const record of records) {
    if (!isExportableRecord(record)) continue;
    const snapshot = record.snapshot;
    const gasSpentUsd = gasSpentUsdFromSnapshot(snapshot);
    rows.push({
      timestamp: new Date(record.timestamp).toISOString(),
      action: record.action,
      tokenId: normalizeTokenId(snapshot.tokenId),
      pool: normalizePool(snapshot),
      amountIn: formatAmountIn(snapshot),
      depositValueUsd: depositValueForRow(record, snapshot, options),
      gasSpentUsd: gasSpentUsd > 0 ? gasSpentUsd : finite(snapshot.gasSpentUsd),
      valueUsd: finite(snapshot.valueUsd),
      txHash: record.txHash,
    });
  }
  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return rows;
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCsvNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

export function taxExportRowsToCsv(rows: readonly LpTaxExportRow[]): string {
  const headers = [
    'timestamp',
    'action',
    'tokenId',
    'pool',
    'amountIn',
    'depositValueUsd',
    'gasSpentUsd',
    'valueUsd',
    'txHash',
  ] as const;

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(
      [
        escapeCsv(row.timestamp),
        escapeCsv(row.action),
        escapeCsv(row.tokenId ?? ''),
        escapeCsv(row.pool ?? ''),
        escapeCsv(row.amountIn ?? ''),
        formatCsvNumber(row.depositValueUsd),
        formatCsvNumber(row.gasSpentUsd),
        formatCsvNumber(row.valueUsd),
        escapeCsv(row.txHash ?? ''),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
