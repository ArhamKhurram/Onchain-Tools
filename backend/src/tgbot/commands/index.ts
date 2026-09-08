import { alerts } from './alerts.js';
import { fees } from './fees.js';
import { flap } from './flap.js';
import { filters } from './filters.js';
import { help } from './help.js';
import { link, unlink as unlinkChat } from './link.js';
import { mcap } from './mcap.js';
import { mute, unmute } from './mute.js';
import { queued } from './queued.js';
import { start } from './start.js';
import { status } from './status.js';
import { token } from './token.js';
import { COMMAND_SPECS } from '../commandCatalog.js';
import type { TgCommand } from './types.js';

// Static registry, same reasoning as bot/commands/index.ts: a runtime folder
// scan does not survive the backend's tsc→ESM build, and explicit imports are
// type-safe. Add a new command here AND to commandCatalog.ts.
//
// THE CATALOG IS THE SOURCE OF TRUTH FOR EVERYTHING BUT BEHAVIOUR. Each handler
// reads its own name and description out of commandCatalog.ts, the help card
// renders from the same table, and index.ts hands that table to Telegram's
// setMyCommands at boot — so the `/` autocomplete menu, the help card and the
// handlers cannot name the same command three different ways. What this file
// still owns is the mapping from a name to the function that runs.
//
// (There is no deploy step: Telegram has no command registry, only the
// autocomplete list handed to it by setMyCommands. `commandListForBotFather()`
// renders the same list in @BotFather's paste format, kept for the manual path.)
export const commands: TgCommand[] = [
  start,
  alerts,
  mute,
  unmute,
  help,
  status,
  token,
  mcap,
  queued,
  fees,
  flap,
  link,
  unlinkChat,
  filters,
];

export const commandMap = new Map<string, TgCommand>(commands.map((c) => [c.name, c]));

/**
 * Names in the catalog with no handler, and handlers missing from the catalog.
 *
 * A catalog entry with no handler is a menu item that does nothing — the exact
 * "a button with nothing behind it is a promise" failure panel.ts warns about,
 * one layer up. A handler with no catalog entry is a command nobody can
 * discover. Neither can be a compile error while the registry is a list, so
 * index.ts logs this once at boot; it is empty in a healthy build.
 */
export function commandCoverageGaps(): { unhandled: string[]; uncatalogued: string[] } {
  const catalogued = new Set(COMMAND_SPECS.map((s) => s.name));
  return {
    unhandled: COMMAND_SPECS.filter((s) => !commandMap.has(s.name)).map((s) => s.name),
    uncatalogued: commands.filter((c) => !catalogued.has(c.name)).map((c) => c.name),
  };
}

/** The `name - description` block to paste into @BotFather /setcommands. */
export function commandListForBotFather(): string {
  return commands.map((c) => `${c.name} - ${c.description}`).join('\n');
}

export type { TgCommand };
