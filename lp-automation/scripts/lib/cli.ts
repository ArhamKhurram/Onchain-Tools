// Shared script shell: uniform error handling, help text, exit codes.
//
// Exit codes are part of the contract, because these scripts are the sort of
// thing people eventually put in a cron job or a CI gate:
//
//   0  everything checked passed
//   1  a check FAILED, or the script refused to act
//   2  bad usage / bad configuration (nothing was attempted)
//
// A non-zero exit never means "probably fine". `preflight` and `verifySetup`
// exit 1 on any FAIL specifically so `&&` chaining does the safe thing.

import { ArgError } from './args.js';
import { ConfirmationDeclined } from './confirm.js';

export const EXIT_OK = 0;
export const EXIT_FAILED_CHECK = 1;
export const EXIT_USAGE = 2;

export function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function printErr(text: string): void {
  process.stderr.write(`${text}\n`);
}

/**
 * Run a script body, translating known error types into clean messages and
 * exit codes. An unknown error is re-thrown with its stack, because an
 * unexpected failure in tooling that touches money should be loud and complete,
 * not summarized into a friendly one-liner.
 */
export async function runScript(name: string, body: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await body();
  } catch (err) {
    if (err instanceof ArgError) {
      printErr(`\n${name}: ${err.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    if (err instanceof ConfirmationDeclined) {
      printErr(`\n${name}: ${err.message}\n`);
      process.exitCode = EXIT_FAILED_CHECK;
      return;
    }
    printErr(`\n${name}: unexpected failure. Nothing should be assumed about on-chain state — verify it.\n`);
    printErr(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = EXIT_FAILED_CHECK;
  }
}

export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}
