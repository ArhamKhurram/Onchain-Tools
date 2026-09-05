// Telegram HTML formatting primitives.
//
// WHY HTML AND NOT MarkdownV2
//
// MarkdownV2 requires that eighteen characters — `_ * [ ] ( ) ~ ` > # + - = | { } . !`
// — be backslash-escaped EVERYWHERE they appear as literal text, including
// inside pre/code blocks and inside the URL part of an inline link, each with
// its own sub-rule. Miss one and Telegram rejects the whole message with a 400
// ("can't parse entities"), so the failure mode is a silently undelivered
// alert. Ticker symbols and token names are attacker-controlled strings full of
// exactly those characters — `$WHY.SO_SERIOUS!` breaks three rules at once.
//
// HTML mode has one rule: replace `&`, `<`, `>` in text with entities (plus `"`
// inside an attribute value). That is the whole spec, it is uniform inside
// <code> and <pre>, and it is implemented once below. Every string that reaches
// a message body goes through escapeHtml — the renderers never interpolate raw.
//
// Telegram's HTML mode accepts only a small tag list (b/strong, i/em, u/ins,
// s/strike/del, a, code, pre, blockquote, tg-spoiler); anything else is a 400.
// The helpers here emit only from that list.

/** Longest message body Telegram accepts (sendMessage `text`). */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * Escape a string for Telegram HTML parse mode.
 *
 * `&` is replaced FIRST — doing it last would re-escape the ampersands of the
 * entities just introduced and render `&lt;` as literal `&amp;lt;`.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape a string for use inside a double-quoted HTML attribute (only `href`
 * here). Same three replacements plus `"`, which would otherwise close the
 * attribute early and let the rest of a hostile URL be parsed as markup.
 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/** `<b>…</b>` around escaped text. */
export function bold(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

/** `<i>…</i>` around escaped text. */
export function italic(text: string): string {
  return `<i>${escapeHtml(text)}</i>`;
}

/**
 * `<code>…</code>` — monospace, and tap-to-copy in every Telegram client.
 * That is the whole reason contract addresses render as code: a group member
 * copies the mint with one tap instead of selecting 44 characters.
 */
export function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

/**
 * `<a href="…">…</a>`.
 *
 * Only http(s) survives. Telegram also resolves `tg://` links, which can
 * silently perform in-app navigation on tap — a token's self-declared website
 * field is not a URL we should be willing to render as one, so anything that
 * is not http(s) comes back as escaped plain text instead of a link.
 */
export function link(label: string, url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return escapeHtml(label);
  return `<a href="${escapeHtmlAttribute(trimmed)}">${escapeHtml(label)}</a>`;
}

/**
 * Clamp PLAIN text to `max` characters, with an ellipsis when it had to cut.
 *
 * Always call this BEFORE escaping. Truncating escaped markup can slice an
 * entity (`&am`) or a tag in half, which is a 400 from Telegram; truncating the
 * plain string cannot, because escaping only ever grows what survives.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Join rendered lines into one message body.
 *
 * `null`/`undefined` mean "this section does not apply" and vanish; `''` is a
 * deliberate blank separator line and is KEPT. The two are different on
 * purpose, because every card is built as a flat list where optional sections
 * sit between fixed ones — treating them the same either collapses the card
 * into an unreadable block or leaves a double gap wherever a section was
 * omitted. So runs of blanks collapse to one, and leading/trailing blanks are
 * trimmed: a card reads the same whether or not its optional parts appeared.
 *
 * The length clamp is a backstop for a payload that grew unexpectedly — every
 * renderer already truncates its own variable-length fields — and it drops
 * whole trailing LINES rather than cutting mid-markup, which would be a 400.
 */
export function joinLines(lines: (string | null | undefined)[]): string {
  const kept: string[] = [];
  let length = 0;

  for (const line of lines) {
    if (line === null || line === undefined) continue;
    // Collapse a run of blanks, and never open the message with one.
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;

    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (length + cost > MAX_MESSAGE_LENGTH) break;
    kept.push(line);
    length += cost;
  }

  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}
