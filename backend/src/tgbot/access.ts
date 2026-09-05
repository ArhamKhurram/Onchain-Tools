// Who the Telegram bot will serve.
//
// A @BotFather bot cannot refuse to be added to a group — anyone with the link
// can drop it into any chat, and it will start receiving that chat's commands
// immediately. That is fine for a free public bot and wrong for this one: the
// alpha ships to ONE chat by agreement with one prospect, and OCT's alert feed
// is not something to hand to whoever finds the username.
//
// So the allowlist is the production posture, and it is deliberately an ENV
// var rather than a database row: it is an operator decision, it must hold
// before any storage is reachable (local mode has no Supabase at all), and a
// bad row in a table should never be able to widen it.
//
//   TG_BOT_ALLOWED_CHAT_IDS set   → only these chat ids are served; everyone
//                                   else gets one polite decline and nothing
//                                   is written to the chat roster.
//   unset                         → any chat that runs /start is served.
//
// Chat ids are signed: a private chat is positive, a group is negative, and a
// supergroup is a large negative (-100…). The parser therefore accepts a
// leading `-`, and any token that is not an integer is dropped with a warning
// rather than silently widening or narrowing the gate.

const ENV_NAMES = ['TG_BOT_ALLOWED_CHAT_IDS', 'OCT_TG_BOT_ALLOWED_CHAT_IDS'] as const;

/**
 * Parse a comma-separated chat-id allowlist.
 *
 * Returns `null` when the variable is absent or blank — "no allowlist", which
 * is NOT the same as an empty allowlist. An empty-but-present value (`,,`,
 * whitespace) is also treated as absent: a var someone half-cleared should not
 * silently take the bot offline in every chat.
 */
export function parseAllowedChatIds(raw: string | undefined): Set<number> | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const ids = new Set<number>();
  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    // Integer only — a chat id is never fractional, and Number('12.5') would
    // otherwise land as a value no chat can ever match.
    if (!/^-?\d+$/.test(token)) {
      console.warn(`[TgBot] Ignoring non-numeric chat id in the allowlist: ${JSON.stringify(token)}`);
      continue;
    }
    const id = Number(token);
    if (!Number.isSafeInteger(id)) {
      console.warn(`[TgBot] Ignoring out-of-range chat id in the allowlist: ${token}`);
      continue;
    }
    ids.add(id);
  }

  return ids.size > 0 ? ids : null;
}

/** The configured allowlist, or null when unset. Read fresh so tests can vary it. */
export function readAllowedChatIds(): Set<number> | null {
  for (const name of ENV_NAMES) {
    const parsed = parseAllowedChatIds(process.env[name]);
    if (parsed) return parsed;
  }
  return null;
}

/** May the bot serve this chat? A null allowlist serves everyone. */
export function isChatAllowed(chatId: number, allowlist: Set<number> | null): boolean {
  return allowlist === null || allowlist.has(chatId);
}

/**
 * What a chat outside the allowlist is told. One short line, no hint about who
 * IS allowed and no invitation to retry — a stranger who added the bot should
 * learn only that it is not for them.
 */
export const DECLINE_MESSAGE =
  'This OCT bot is limited to approved chats right now. Ask the OCT team if you need access.';
