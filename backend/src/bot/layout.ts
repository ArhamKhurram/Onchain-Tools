// Components V2 builders + formatting helpers, ported from the standalone
// Outpost bot (src/lib/layout.ts). Kept verbatim in behaviour so the embeds look
// identical; only the formatting helpers at the bottom are new.
//
// Retiring the FOMO commands removed the only paginated, thumbnailed and
// PnL-badged surfaces, so makeNavRow / makeThumbnail / makeSection / pnlBadge
// went with them. What's left is what /ping, /token, alerts and announcements
// actually render — plus makeSection/makeThumbnail, which came back for the
// pump.fun callout cards (a caller's avatar next to their headline).
//
// The three number/address formatters this file used to define (usd,
// compactUsd, shortAddress) moved to @oct/shared when the Telegram bot landed
// as a second transport over the same data: a market cap reads the same in an
// embed and in a Telegram message, whereas everything else here is Discord
// Components V2 and stays. They are re-exported below so no call site changed.

export { usd, compactUsd, shortAddress } from '@oct/shared';

export const BRAND = {
  red: 0xed4245,
  blurple: 0x5865f2,
  green: 0x57f287,
  gold: 0xfee75c,
  white: 0xffffff,
};

/** OCT site brand accent (frontend/src/styles/cockpit-tokens.ts accentRed) — used
 * for anything meant to look like it came from the site, e.g. announcements. */
export const SITE_ACCENT = 0xff2a2a;

/**
 * Bot signature shown at the foot of every response.
 *
 * One constant rather than a literal per command: it was previously repeated in
 * seven files, all still reading "Outpost" after the Discord app was renamed to
 * onchain-tools. Change it here and every surface follows.
 */
export const BOT_SIGNATURE = 'OCT 👀';

/** `-# … · OCT 👀` — the standard small-print footer line. */
export function botFooter(prefix?: string): string {
  return prefix ? `-# ${prefix} · ${BOT_SIGNATURE}` : `-# ${BOT_SIGNATURE}`;
}

export function makeSeparator(spacing: number = 1) {
  return { type: 14, spacing, divider: true };
}

export function makeText(content: string) {
  return { type: 10, content };
}

/** Media gallery — a single full-width image (Components V2 type 12). */
export function makeImage(url: string) {
  return { type: 12, items: [{ media: { url } }] };
}

/** Thumbnail accessory (Components V2 type 11) — only valid inside a section. */
export function makeThumbnail(url: string) {
  return { type: 11, media: { url } };
}

/**
 * Section (Components V2 type 9): up to three text components with one accessory
 * (a thumbnail or a button) floated to the right. This is the only V2 shape that
 * puts a small image *beside* text — makeImage is a full-width gallery.
 */
export function makeSection(components: any[], accessory: any) {
  return { type: 9, components, accessory };
}

export function makeContainer(accentColor: number, components: any[]) {
  return { type: 17, accent_color: accentColor, components };
}

export function quoteLines(text: string) {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** A single-container error/notice card. */
export function noticeCard(message: string, color: number = BRAND.red) {
  return [makeContainer(color, [makeText(message)])];
}
