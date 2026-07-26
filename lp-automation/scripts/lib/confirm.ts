// Typed confirmation.
//
// `y/n` is not a confirmation, it is a reflex. Every broadcast in this tooling
// requires the human to type a specific string that they can only produce by
// having read the thing they are confirming — the full Safe address, or the
// chain id. Muscle memory cannot get past it.
//
// There is deliberately no `--yes` shortcut on any broadcasting path. `--yes`
// exists in the flag table only so that passing it produces an explicit refusal
// rather than being silently ignored.

import { createInterface } from 'node:readline';

export class ConfirmationDeclined extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmationDeclined';
  }
}

/** Read one line from stdin. Returns '' on EOF (non-interactive stdin). */
async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolveLine) => {
      rl.question(prompt, (answer) => resolveLine(answer));
    });
  } finally {
    rl.close();
  }
}

export interface ConfirmOptions {
  /** The exact string the human must type. Compared case-insensitively, trimmed. */
  readonly phrase: string;
  /** What typing it means, printed above the prompt. */
  readonly meaning: string;
}

/**
 * Demand an exact typed phrase before proceeding.
 *
 * Refuses outright when stdin is not a TTY. An unattended pipeline must not be
 * able to satisfy a human confirmation by supplying an empty line, and
 * `echo "0x..." | tsx deployModule.ts --broadcast` should not be a supported
 * way to deploy — if you want that, you have decided to remove the safety and
 * should have to edit the script to do it.
 */
export async function requireTypedConfirmation(options: ConfirmOptions): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new ConfirmationDeclined(
      'stdin is not an interactive terminal, so the typed confirmation cannot be given. ' +
        'This script will not broadcast non-interactively. Run it from a real terminal.',
    );
  }

  process.stdout.write(`\n${options.meaning}\n`);
  const answer = await readLine(`Type exactly:  ${options.phrase}\n> `);

  if (answer.trim().toLowerCase() !== options.phrase.trim().toLowerCase()) {
    throw new ConfirmationDeclined(
      'Confirmation phrase did not match. Nothing was broadcast. (This is the expected outcome ' +
        'if you were not sure — run it again when you are.)',
    );
  }
}

/**
 * Whether a broadcast is authorized at the flag level.
 *
 * Pure and separate from the prompt so it is testable, and so the rule
 * "--broadcast is required, --yes is never enough" is stated in exactly one
 * place.
 */
export function checkBroadcastFlags(flags: {
  broadcast: boolean;
  yes: boolean;
}): { allowed: boolean; reason: string } {
  if (flags.yes) {
    return {
      allowed: false,
      reason:
        '--yes is not accepted by this tooling. Broadcasting requires --broadcast AND a typed ' +
        'confirmation at the terminal; there is no non-interactive path on purpose.',
    };
  }
  if (!flags.broadcast) {
    return {
      allowed: false,
      reason: 'DRY RUN (default). Nothing was sent. Re-run with --broadcast to actually deploy.',
    };
  }
  return { allowed: true, reason: '--broadcast was passed; a typed confirmation is still required.' };
}
