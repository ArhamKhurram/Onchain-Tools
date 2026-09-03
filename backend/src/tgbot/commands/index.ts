import { help } from './help.js';
import { start } from './start.js';
import { status } from './status.js';
import { token } from './token.js';
import type { TgCommand } from './types.js';

// Static registry, same reasoning as bot/commands/index.ts: a runtime folder
// scan does not survive the backend's tsc→ESM build, and explicit imports are
// type-safe. Add a new command here.
//
// Unlike Discord there is no deploy step — Telegram has no command REGISTRY,
// only an optional autocomplete list you hand to @BotFather with /setcommands.
// `commandListForBotFather()` renders exactly that, so the hint list and the
// handlers cannot drift.
export const commands: TgCommand[] = [start, help, status, token];

export const commandMap = new Map<string, TgCommand>(commands.map((c) => [c.name, c]));

/** The `name - description` block to paste into @BotFather /setcommands. */
export function commandListForBotFather(): string {
  return commands.map((c) => `${c.name} - ${c.description}`).join('\n');
}

export type { TgCommand };
