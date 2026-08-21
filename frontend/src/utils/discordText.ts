// Discord custom-emoji markup is `<:name:id>` (static) or `<a:name:id>`
// (animated). The chat renderer (components/message/content.tsx) turns these
// into <img> tags from Discord's CDN, which is right for a full message.
//
// Compact surfaces that render a *plain-text* excerpt — notably the contract
// feed's `description`, which comes verbatim from a Rick embed and often reads
// like `<:sol:941653282420576296> Solana @ Pump` — have no such renderer, so
// the raw markup leaks on screen. Strip it there; the chain word usually
// follows the emoji anyway, so the line stays legible.

/** Matches `<:name:id>` and `<a:name:id>`. Mirrors content.tsx's EMOJI_REGEX. */
const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;

/**
 * Remove Discord custom-emoji markup and tidy the whitespace it leaves behind.
 * Unicode emoji (🔥, 🚀) are untouched — only the `<:name:id>` tokens go.
 */
export function stripDiscordCustomEmoji(text: string): string {
  return text.replace(CUSTOM_EMOJI, '').replace(/\s{2,}/g, ' ').trim();
}
