// Message bodies for the Telegram bot.
//
// The Discord bot renders Components V2 containers (bot/layout.ts); Telegram
// has no such thing, so this is its parallel — the same information, laid out
// for a chat client that only understands a handful of inline tags. What the
// two DO share is the number and address formatting (usd/compactUsd/
// shortAddress, now in @oct/shared) and the brand signature, so a market cap
// never reads one way in Discord and another in Telegram.
//
// EVERY interpolated string goes through the helpers in html.ts. There is no
// raw template interpolation of a token name, a channel name, a chat title or
// a message body anywhere below: all four are attacker-controlled, and an
// unescaped `<` is a 400 from Telegram, which means a silently undelivered
// alert rather than a visible bug.

import { buildContractUrl, compactUsd, shortAddress, type ContractLinkTemplates } from '@oct/shared';
import type { BotSnapshotResponse } from '@oct/shared';
// The signature is brand, not Discord — one constant so the two bots cannot
// drift apart. (j7/fanout.ts already borrows from bot/layout.ts the same way.)
import { BOT_SIGNATURE } from '../bot/layout.js';
import { bold, code, escapeHtml, italic, joinLines, link, truncate } from './html.js';
import type { TgChatRecord } from './chatStore.js';

/**
 * Chart links use OCT's shipped defaults rather than a user's own preferences:
 * a group chat is not one OCT user, so there is no "their" platform to read.
 * Matches DEFAULT_CONFIG.contractLinkTemplates in config/store.ts.
 */
const LINK_TEMPLATES: ContractLinkTemplates = {
  evm: 'https://gmgn.ai/base/token/{address}',
  sol: 'https://axiom.trade/t/{address}?chain=sol',
  solPlatform: 'axiom',
  evmPlatform: 'gmgn',
};

/** Longest quoted message body in an alert card. */
const MAX_QUOTE_CHARS = 280;
/** Longest echoed name (author, channel, chat title, token name). */
const MAX_NAME_CHARS = 64;

/** `— OCT 👀`, the small-print foot of every card. */
export function footer(prefix?: string): string {
  return italic(prefix ? `${prefix} · ${BOT_SIGNATURE}` : BOT_SIGNATURE);
}

/**
 * Clamp a name-shaped field to a sane width. Returns PLAIN text, never escaped
 * markup — the caller escapes exactly once, at the point it composes.
 *
 * Returning escaped HTML here was a bug: a caller that then wrapped it in
 * bold() escaped it a second time and a token called `<IMG>` rendered as
 * `&amp;lt;IMG&amp;gt;`. The rule this enforces is that nothing in this file
 * holds a pre-escaped string in a variable.
 */
function clampName(value: string | null | undefined, fallback = '—'): string {
  const text = (value ?? '').trim();
  return text === '' ? fallback : truncate(text, MAX_NAME_CHARS);
}

/** The common case: clamp then escape, for interpolation into a line. */
function name(value: string | null | undefined, fallback = '—'): string {
  return escapeHtml(clampName(value, fallback));
}

/** `/start` — registration confirmation and what the bot is for. */
export function renderStart(chatTitle: string | null, isGroup: boolean): string {
  return joinLines([
    bold('OCT is listening. 👀'),
    '',
    isGroup
      ? `This chat${chatTitle ? ` (${name(chatTitle)})` : ''} is registered. Contract detections from the OCT feed will land here.`
      : 'This chat is registered. Contract detections from the OCT feed will land here.',
    '',
    `No Telegram or Discord account of yours is connected, and none is needed — this bot reads only messages addressed to it with a ${code('/command')}.`,
    '',
    `Type ${code('/help')} for the command list.`,
    '',
    footer(),
  ]);
}

/** `/help` — the command list. */
export function renderHelp(): string {
  return joinLines([
    bold('OCT bot commands'),
    '',
    `${code('/start')} — register this chat for OCT alerts`,
    `${code('/help')} — this list`,
    `${code('/status')} — what this chat is registered for`,
    `${code('/token <address> [chain]')} — market snapshot from OCT enrichment`,
    '',
    italic('In a group, add @thebotname to any command if other bots are present.'),
    '',
    footer(),
  ]);
}

/** `/status` — registration state, alert routing, plan. */
export function renderStatus(
  record: TgChatRecord | null,
  opts: { alertsRouted: boolean; allowlisted: boolean },
): string {
  if (!record) {
    return joinLines([
      bold('Not registered'),
      '',
      `Run ${code('/start')} in this chat to register it.`,
      '',
      footer(),
    ]);
  }

  return joinLines([
    bold('OCT bot status'),
    '',
    `${bold('Chat:')} ${name(record.title, record.chatType)} (${escapeHtml(record.chatType)})`,
    `${bold('Active:')} ${record.enabled ? 'yes' : 'no'}`,
    `${bold('Contract alerts:')} ${record.settings.contractAlerts ? 'on' : 'off'}`,
    // Honest about the one case where a chat is registered but will never
    // receive anything: no alert source is bound to it. Silently "on" would be
    // the worse answer.
    opts.alertsRouted
      ? null
      : italic('No alert source is bound to this chat yet, so no alerts will arrive.'),
    `${bold('Plan:')} ${escapeHtml(record.plan)}`,
    opts.allowlisted ? `${bold('Access:')} approved chat` : null,
    '',
    // footer() escapes its prefix, so this is handed plain text.
    footer(`Since ${record.createdAt.slice(0, 10)}`),
  ]);
}

/**
 * `/token <address> [chain]` — the Telegram twin of the Discord /token embed.
 * Both read getBotSnapshot, so the numbers are the same enrichment record.
 */
export function renderTokenSnapshot(snap: BotSnapshotResponse): string {
  if (!snap.found) {
    return joinLines([
      `🔍 No enrichment data for ${code(shortAddress(snap.address))} on ${code(snap.chain)}.`,
      footer(),
    ]);
  }

  const ticker = clampName((snap.symbol ?? 'TOKEN').toUpperCase().replace(/^\$/, ''), 'TOKEN');
  // Built from PLAIN text and escaped once by bold() — see clampName's note.
  const heading =
    snap.name && snap.name.toUpperCase() !== ticker
      ? `💠 $${ticker} — ${clampName(snap.name)}`
      : `💠 $${ticker}`;

  const marketLines = [
    snap.marketCap != null
      ? `${bold('MCap:')} ${escapeHtml(snap.marketCapDisplay ?? compactUsd(snap.marketCap))}`
      : null,
    snap.priceUsd != null
      ? `${bold('Price:')} ${escapeHtml(`$${snap.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}`)}`
      : null,
    snap.liquidityUsd != null ? `${bold('Liquidity:')} ${escapeHtml(compactUsd(snap.liquidityUsd))}` : null,
  ].filter((l): l is string => l !== null);

  return joinLines([
    bold(heading),
    `${bold('Chain:')} ${code(snap.chain)}`,
    code(snap.address),
    '',
    ...(marketLines.length > 0 ? marketLines : [italic('No market data available.')]),
    '',
    link('Chart ↗', buildContractUrl(snap.address, LINK_TEMPLATES)),
    footer(`Source: ${snap.source ?? 'unknown'}${snap.stale ? ' (stale)' : ''}`),
  ]);
}

/** The subset of an OCT alert this card renders. */
export interface ContractAlertView {
  reason: string;
  author: string | null;
  guildName: string | null;
  channelName: string | null;
  source: string | null;
  content: string;
  addresses: string[];
}

/**
 * A contract detection, as a Telegram card.
 *
 * Addresses are `<code>` so they are tap-to-copy — the single most useful
 * property this card can have, since the next thing anyone does with a fresh
 * mint is paste it into a chart or a bot. At most three are shown: a message
 * that scanned more than three is a list, not a call.
 */
export function renderContractAlert(view: ContractAlertView): string {
  // Plain text until the line that composes it — see clampName.
  const where = [view.guildName, view.channelName]
    .filter((v): v is string => !!v)
    .map((v) => clampName(v));
  const body = view.content.trim();
  const addresses = view.addresses.slice(0, 3);
  const overflow = view.addresses.length - addresses.length;

  return joinLines([
    bold('💠 Contract scan'),
    escapeHtml(truncate(view.reason, 200)),
    '',
    view.author ? `${bold('From:')} ${name(view.author)}` : null,
    where.length > 0
      ? `${bold('Where:')} ${escapeHtml(where.join(' · '))}${view.source ? ` (${escapeHtml(view.source)})` : ''}`
      : null,
    body ? `<blockquote>${escapeHtml(truncate(body, MAX_QUOTE_CHARS))}</blockquote>` : null,
    '',
    ...addresses.map((addr) => `${code(addr)}\n${link('Chart ↗', buildContractUrl(addr, LINK_TEMPLATES))}`),
    overflow > 0 ? italic(`+${overflow} more in the same message`) : null,
    footer(),
  ]);
}
