import { holders } from './holders.js';
import { leaderboard } from './leaderboard.js';
import { ping } from './ping.js';
import { token } from './token.js';
import type { BotCommand } from './types.js';

// Static registry — the standalone bot scanned the commands folder at runtime,
// which doesn't survive the backend's tsc→ESM build. Explicit imports are
// type-safe and tree-shakeable; add new commands here.
export const commands: BotCommand[] = [ping, holders, leaderboard, token];

export const commandMap = new Map<string, BotCommand>(commands.map((c) => [c.data.name, c]));

export type { BotCommand };
