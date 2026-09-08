// Update routing: what, if anything, one Telegram update asks the bot to do.
//
// Everything here is PURE — no I/O, no clock, no module state. classifyUpdate
// takes an update plus the two facts it needs (our @username, the allowlist)
// and returns a decision; index.ts is what executes one. That split is what
// makes the group-chat behaviour testable, and group-chat behaviour is the part
// that has to be right: the bot sits in someone else's chat, and the promise
// made to them is that it reads nothing it was not addressed with.
//
// WHAT ARRIVES IN A GROUP
//
// With @BotFather privacy mode ON (the default, and the setting OCT wants), a
// bot in a group receives only: messages beginning with `/`, replies to its own
// messages, and service messages. It does NOT receive ordinary chatter. That is
// the privacy story, and it is enforced by Telegram rather than by us.
//
// But "begins with a slash" includes commands aimed at OTHER bots — `/stats@
// otherbot` is delivered to every bot in the room. So the suffix check below is
// load-bearing, not cosmetic: an unsuffixed `/cmd` is addressed to us by
// Telegram's own convention, `/cmd@ourname` is explicitly ours, and
// `/cmd@anyoneelse` is somebody else's message that we must not answer.

import type { TgCallbackQuery, TgChat, TgUpdate, TgUser } from './types.js';
import { isChatAllowed } from './access.js';

export interface ParsedCommand {
  /** Lowercased, without the leading slash and without any `@bot` suffix. */
  name: string;
  /** Everything after the command, whitespace-collapsed. */
  args: string[];
  /** The raw argument tail, for commands that want it unsplit. */
  rest: string;
  /** The `@suffix` the user typed, lowercased; null when they typed none. */
  addressedTo: string | null;
}

/**
 * Parse a message body as a bot command.
 *
 * Returns null for anything that is not one — ordinary text, an empty message,
 * a bare `/`, or a command aimed at a different bot. `botUsername` is compared
 * case-insensitively because Telegram autocompletes the case it stored while
 * users type whatever they like.
 *
 * A leading space disqualifies the message: Telegram only marks a `bot_command`
 * entity at offset 0, so ` /help` is chat text that happens to contain a slash.
 */
export function parseCommand(text: string, botUsername: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;

  // Telegram splits the command off at the first whitespace of any kind.
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;

  const [, rawName, rawSuffix, rawRest] = match;
  if (!rawName) return null;

  const addressedTo = rawSuffix ? rawSuffix.toLowerCase() : null;
  const me = botUsername.replace(/^@/, '').toLowerCase();
  // Someone else's bot was named — not our message to answer.
  if (addressedTo !== null && me !== '' && addressedTo !== me) return null;

  const rest = (rawRest ?? '').trim();
  return {
    name: rawName.toLowerCase(),
    args: rest === '' ? [] : rest.split(/\s+/),
    rest,
    addressedTo,
  };
}

/**
 * A bare contract address, as `/token <address>`.
 *
 * WHY THIS EXISTS. Pasting a mint into a DM and getting a snapshot is what
 * every trading bot does, and it is what people try first — typing `/token`
 * before the address is a step nobody expects. The command is not removed:
 * this is a second door onto the same handler, and `/token <addr> <chain>`
 * remains the way to name a chain.
 *
 * PRIVATE CHATS ONLY, and that restriction is the whole safety argument. In a
 * group, "answer any message that looks like an address" would break the
 * promise the bot is sold on — that it reads only what is addressed to it —
 * and would make it a bot that talks over every call in the room. Telegram's
 * privacy mode does not save us here: a REPLY to one of the bot's own messages
 * IS delivered, so a group member quoting a card and pasting an address would
 * otherwise trigger it. classifyUpdate checks the chat type, not the privacy
 * setting.
 *
 * The shape test is deliberately loose — base58 of plausible length, or an EVM
 * `0x…` — because the handler already bounds the work (length check, then one
 * catalog read) and a stricter check here would reject real addresses on
 * chains OCT adds later. Returns null for anything with whitespace in it: a
 * sentence that happens to contain an address is chat, not a lookup.
 */
export function bareAddressCommand(text: string): ParsedCommand | null {
  const candidate = text.trim();
  if (candidate === '' || /\s/.test(candidate)) return null;

  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(candidate);
  const isBase58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate);
  if (!isEvm && !isBase58) return null;

  return { name: 'token', args: [candidate], rest: candidate, addressedTo: null };
}

/** What index.ts should do about one update. */
export type RouteDecision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'decline'; chatId: number }
  | { kind: 'callback'; query: TgCallbackQuery }
  | {
      kind: 'command';
      chatId: number;
      chat: TgChat;
      from: TgUser | null;
      command: ParsedCommand;
    };

export interface RouteContext {
  /** The bot's own @username, from getMe. */
  botUsername: string;
  /** Allowed chat ids, or null for "serve everyone". */
  allowlist: Set<number> | null;
}

/**
 * Classify one update.
 *
 * Only `message` is considered. `edited_message` is skipped on purpose — a user
 * editing an old `/token` into a new one would otherwise re-fire the command
 * silently, minutes later, with no visible trigger. `channel_post` is skipped
 * too: a channel has no interactive sender to answer.
 */
export function classifyUpdate(update: TgUpdate, ctx: RouteContext): RouteDecision {
  // A panel button press. It is routed BEFORE the message branch and is NOT
  // allowlist-checked here: the check exists, but it belongs with the rest of
  // the per-press authorization in panel.ts's decidePanelPress, where the
  // refusal can be delivered as an answered callback query rather than as a
  // chat message. Answering a press with a new message is exactly the spam the
  // panel is built to avoid, and a chat outside the allowlist has already been
  // told once.
  //
  // A press from a bot is dropped for the same reason a message from one is:
  // that is how loops start. Telegram does not currently deliver such a query,
  // which is why this is a cheap guard rather than a load-bearing one.
  const callback = update.callback_query;
  if (callback) {
    if (callback.from.is_bot) return { kind: 'ignore', reason: 'callback from a bot' };
    return { kind: 'callback', query: callback };
  }

  const message = update.message;
  if (!message) return { kind: 'ignore', reason: 'not a new message' };

  const text = message.text;
  if (typeof text !== 'string' || text === '') {
    return { kind: 'ignore', reason: 'no text' };
  }

  // A bot answering another bot is how loops start.
  if (message.from?.is_bot) return { kind: 'ignore', reason: 'from a bot' };

  // The single rule that keeps the bot quiet in someone else's group: anything
  // that is not a command addressed to us is dropped before any other check.
  // The ONE exception is a bare contract address in a DM, where there is no
  // room to be quiet in and no other conversation to talk over — see
  // bareAddressCommand for why it can never apply to a group.
  const command =
    parseCommand(text, ctx.botUsername) ??
    (message.chat.type === 'private' ? bareAddressCommand(text) : null);
  if (!command) return { kind: 'ignore', reason: 'not a command for this bot' };

  const chatId = message.chat.id;
  if (!isChatAllowed(chatId, ctx.allowlist)) return { kind: 'decline', chatId };

  return {
    kind: 'command',
    chatId,
    chat: message.chat,
    from: message.from ?? null,
    command,
  };
}

/**
 * The offset to send with the next getUpdates: one past the highest id seen.
 *
 * Telegram treats this as an acknowledgement, not a cursor — until an update is
 * confirmed this way it is redelivered on every poll, so a batch that produced
 * no action still has to advance the offset. Returns the current offset
 * unchanged for an empty batch.
 */
export function nextOffset(updates: TgUpdate[], current: number): number {
  let highest = current - 1;
  for (const u of updates) if (u.update_id > highest) highest = u.update_id;
  return highest + 1;
}
