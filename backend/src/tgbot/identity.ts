// The bot's own @username, and the one sentence that needs it.
//
// THE BUG THIS FILE IS THE FIX FOR. Both help cards shipped the literal string
// "In a group, add @thebotname to any command…" — a placeholder that reached
// production, where every reader saw it verbatim. The value was never missing:
// index.ts calls getMe at boot and already threads `username` into the poll
// loop. It simply never reached a renderer, because the renderers are pure and
// nothing passed it in. So the fix is a parameter, and this module is the one
// place that turns that parameter into prose.
//
// IT IS A PARAMETER AND NOT A CONSTANT, DELIBERATELY. Hardcoding the production
// handle would relocate the bug rather than fix it: the same build runs against
// a separate test bot, and a card that confidently names the wrong bot is worse
// than one that names none — a group would type `/alerts@wrongname` and be
// answered by nobody, silently, because router.ts drops commands addressed to
// someone else.
//
// getMe CAN LEGITIMATELY RETURN NO USERNAME. `TgUser.username` is optional in
// the wire type and index.ts reads it as `?? ''`. With no handle there is no
// true sentence to write, so `groupMentionNote` returns null and joinLines
// drops the line entirely. Rendering "add @ to any command" — a sentence with a
// hole in it — is the one outcome that is not allowed, and it is what the unit
// test pins.

/**
 * Normalize whatever we were handed into a bare handle: no leading `@`, no
 * surrounding whitespace. Telegram usernames are `[A-Za-z0-9_]{5,32}`; anything
 * that is not that shape is treated as "no username", because a malformed
 * handle in a `/cmd@handle` instruction is worse than no instruction.
 */
export function normalizeBotUsername(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{5,32}$/.test(trimmed) ? trimmed : '';
}

/** `@handle`, or null when there is no usable handle. */
export function botMention(raw: string | null | undefined): string | null {
  const username = normalizeBotUsername(raw);
  return username === '' ? null : `@${username}`;
}

/**
 * The line every help card ends on: how to address this bot in a room that
 * holds several.
 *
 * Returns PLAIN text — the caller escapes exactly once, the rule render.ts's
 * clampName note sets out — and null when the handle is unknown, which reads as
 * "this section does not apply" to joinLines.
 */
export function groupMentionNote(raw: string | null | undefined): string | null {
  const mention = botMention(raw);
  return mention === null
    ? null
    : `In a group, add ${mention} to any command if other bots are present.`;
}
