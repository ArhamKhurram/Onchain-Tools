// Components V2 builders + formatting helpers, ported from the standalone
// Outpost bot (src/lib/layout.ts). Kept verbatim in behaviour so the embeds look
// identical; only the formatting helpers at the bottom are new.
//
// Retiring the FOMO commands removed the only paginated, thumbnailed and
// PnL-badged surfaces, so makeNavRow / makeThumbnail / makeSection / pnlBadge
// went with them. What's left is what /ping, /token, alerts and announcements
// actually render.

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

export function makeContainer(accentColor: number, components: any[]) {
  return { type: 17, accent_color: accentColor, components };
}

export function quoteLines(text: string) {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

// --- Formatting helpers ----------------------------------------------------

/** `$1,234` — whole-dollar, comma-grouped. Backs compactUsd below the 1K mark. */
export function usd(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** `$1.2M` / `$980.5K` — compact market caps. */
export function compactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return usd(value);
}

/** `7xK…pump` — short address for tight embed lines. */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}..${address.slice(-4)}`;
}

/** A single-container error/notice card. */
export function noticeCard(message: string, color: number = BRAND.red) {
  return [makeContainer(color, [makeText(message)])];
}
