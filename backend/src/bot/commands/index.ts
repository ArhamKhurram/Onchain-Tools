import { ping } from './ping.js';
import { token } from './token.js';
import type { BotCommand } from './types.js';

// Static registry — the standalone bot scanned the commands folder at runtime,
// which doesn't survive the backend's tsc→ESM build. Explicit imports are
// type-safe and tree-shakeable; add new commands here.
//
// The FOMO commands (/holders, /leaderboard, /tracked, /wallet) were retired
// once the console reached parity — see docs/architecture/discord-bot.md. The
// bot stays online: DM alerts and announcements are untouched, and /token reads
// OCT's own enrichment catalog rather than FOMO.
//
// deployCommands.ts PUTs this list wholesale, so `npm run bot:deploy -w backend`
// is what actually deregisters a removed command with Discord.
export const commands: BotCommand[] = [ping, token];

export const commandMap = new Map<string, BotCommand>(commands.map((c) => [c.data.name, c]));

export type { BotCommand };
