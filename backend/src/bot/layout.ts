import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// Components V2 builders + formatting helpers, ported from the standalone
// Outpost bot (src/lib/layout.ts). Kept verbatim in behaviour so the embeds look
// identical; only the formatting helpers at the bottom are new.

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

export function makeNavRow(prefix: string, interactionId: string, page: number, totalPages: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:first:${interactionId}`)
      .setLabel('First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev:${interactionId}`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next:${interactionId}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`${prefix}:last:${interactionId}`)
      .setLabel('Last')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

export function makeSeparator(spacing: number = 1) {
  return { type: 14, spacing, divider: true };
}

export function makeText(content: string) {
  return { type: 10, content };
}

export function makeThumbnail(url: string, name?: string) {
  const thumbnail: any = {
    type: 11,
    media: { url },
    spoiler: false,
  };
  if (name) thumbnail.description = name;
  return thumbnail;
}

export function makeSection(accessory: any, textComponents: any[]) {
  return { type: 9, components: textComponents, accessory };
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

/** `$1,234` — whole-dollar, comma-grouped. */
export function usd(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** `+$1,234` / `-$1,234` with a red/green dot, for PnL. */
export function pnlBadge(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  const dot = value >= 0 ? '🟢' : '🔴';
  return `${dot} ${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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
