// Read the LP automation audit log for dashboard PnL derivation.
//
// The log lives on the worker's persistent volume. The backend reads the same
// JSONL via LP_AUDIT_LOG_PATH — no Supabase mirror, no second source of truth.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AuditRecordLike {
  id: string;
  phase: 'intent' | 'success' | 'failure';
  timestamp: number;
  action: string;
  rule: string;
  snapshot: Record<string, unknown>;
  txHash: string | null;
  error: string | null;
}

export function parseAuditLog(body: string): { records: AuditRecordLike[]; malformed: string[] } {
  const records: AuditRecordLike[] = [];
  const malformed: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as AuditRecordLike);
    } catch {
      malformed.push(trimmed);
    }
  }
  return { records, malformed };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_AUDIT_RELATIVE = join('lp-automation', 'data', 'audit.jsonl');

/** Candidate paths when LP_AUDIT_LOG_PATH is unset (local dev). */
export function defaultAuditLogCandidates(
  cwd = process.cwd(),
  moduleDir = __dirname,
): readonly string[] {
  return [
    join(cwd, DEFAULT_AUDIT_RELATIVE),
    join(moduleDir, '../../../lp-automation/data/audit.jsonl'),
  ];
}

/**
 * Resolve audit log path from env, else the repo-local worker log.
 *
 * When unset, tries `lp-automation/data/audit.jsonl` relative to `process.cwd()`
 * and to this module (works whether the backend is started from repo root or
 * `backend/`). Prefer an existing file; otherwise return the module-relative
 * default so `readAuditLog` can report `available: false` without extra env.
 */
export function auditLogPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.LP_AUDIT_LOG_PATH?.trim();
  if (explicit) return explicit;

  const candidates = defaultAuditLogCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[1] ?? candidates[0] ?? null;
}

/** ETH/USD for reconstructing zap deposits when audit snapshots omit nativeTokenUsd. */
export function nativeTokenUsdFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.LP_NATIVE_TOKEN_USD?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function readAuditLog(
  filePath: string,
): Promise<{ records: AuditRecordLike[]; malformed: string[]; available: boolean }> {
  try {
    const body = await readFile(filePath, 'utf8');
    const parsed = parseAuditLog(body);
    return { ...parsed, available: true };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { records: [], malformed: [], available: false };
    }
    throw err;
  }
}
