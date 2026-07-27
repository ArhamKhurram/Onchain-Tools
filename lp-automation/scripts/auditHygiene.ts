#!/usr/bin/env tsx
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Hash } from 'viem';
import { parseLog } from '../src/audit/log.js';
import { ArgError, parseArgs } from './lib/args.js';
import {
  buildHygieneSidecar,
  hygieneSidecarPath,
  scanAuditHygiene,
  type ReceiptLookup,
  type ScanLine,
} from './lib/auditHygiene.js';
import { buildPublicClient } from './lib/client.js';
import { EXIT_FAILED_CHECK, EXIT_OK, print, runScript, wantsHelp } from './lib/cli.js';
import { loadEnv, optionalEnv, WORKSPACE_ROOT } from './lib/env.js';

const HELP = `
auditHygiene.ts — scan audit.jsonl for false successes and missing gas fields

  npx tsx scripts/auditHygiene.ts [flags]

Flags
  --audit-path <path>   Audit JSONL to scan (default: ./data/audit.jsonl or LP_AUDIT_LOG_PATH)
  --rpc-url <url>       Optional RPC URL to verify tx receipts by hash
  --out <path>          Write the JSON report to a file (default: stdout)
  --annotate            Also write a correction sidecar next to the audit log
  --native-token-usd <n> ETH/USD for gas backfill suggestions (default: LP_NATIVE_TOKEN_USD)
  --help                This text
`;

function defaultAuditPath(): string {
  return optionalEnv('LP_AUDIT_LOG_PATH') ?? resolve(WORKSPACE_ROOT, 'data', 'audit.jsonl');
}

function parseNativeTokenUsd(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function recordsToLines(body: string): { lines: ScanLine[]; malformed: string[] } {
  const { records, malformed } = parseLog(body);
  const lines: ScanLine[] = records.map((record, index) => ({
    lineNumber: index + 1,
    record,
  }));
  return { lines, malformed };
}

function makeReceiptLookup(
  lookup: (hash: Hash) => Promise<{
    status: 'success' | 'reverted';
    gasUsed: bigint;
    effectiveGasPrice: bigint;
  } | null>,
): ReceiptLookup {
  return async (txHash: string) => lookup(txHash as Hash);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    print(HELP.trim());
    return EXIT_OK;
  }

  loadEnv();
  const parsed = parseArgs(argv);
  const auditLogPath = resolve(parsed.values.get('audit-path') ?? defaultAuditPath());
  const outPath = parsed.values.get('out');
  const annotate = parsed.booleans.has('annotate');
  const rpcUrl = parsed.values.get('rpc-url') ?? optionalEnv('LP_RPC_URL');
  const nativeTokenUsd =
    parseNativeTokenUsd(parsed.values.get('native-token-usd')) ??
    parseNativeTokenUsd(optionalEnv('LP_NATIVE_TOKEN_USD'));

  let body: string;
  try {
    body = await readFile(auditLogPath, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new ArgError(`audit log not found: ${auditLogPath}`);
    throw err;
  }

  const { lines, malformed } = recordsToLines(body);

  let lookupReceipt: ReceiptLookup | undefined;
  let rpcChecked = false;
  if (rpcUrl) {
    const { publicClient } = buildPublicClient(rpcUrl);
    lookupReceipt = makeReceiptLookup(async (hash) => {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return {
        status: receipt.status,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
      };
    });
    rpcChecked = true;
  }

  const report = await scanAuditHygiene({
    auditLogPath,
    lines,
    malformedLineCount: malformed.length,
    rpcChecked,
    lookupReceipt,
    nativeTokenUsd,
  });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    await writeFile(resolve(outPath), json, 'utf8');
  } else {
    print(json.trimEnd());
  }

  if (annotate) {
    const sidecar = buildHygieneSidecar(report);
    const sidecarPath = hygieneSidecarPath(auditLogPath);
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
    print(`wrote correction sidecar: ${sidecarPath}`);
  }

  return report.clean ? EXIT_OK : EXIT_FAILED_CHECK;
}

runScript('auditHygiene', main);
