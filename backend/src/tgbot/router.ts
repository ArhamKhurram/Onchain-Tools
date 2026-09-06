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

  const command = parseCommand(text, ctx.botUsername);
  // The single rule that keeps the bot quiet in someone else's group: anything
  // that is not a command addressed to us is dropped before any other check.
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
