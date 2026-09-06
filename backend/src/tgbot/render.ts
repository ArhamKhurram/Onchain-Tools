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

import {
  buildContractUrl,
  buildRevivalContractUrl,
  compactUsd,
  revivalNetworkLabel,
  shortAddress,
  type ContractLinkTemplates,
} from '@oct/shared';
import type { BotSnapshotResponse } from '@oct/shared';
// The signature is brand, not Discord — one constant so the two bots cannot
// drift apart. (j7/fanout.ts already borrows from bot/layout.ts the same way.)
import { BOT_SIGNATURE } from '../bot/layout.js';
import { bold, code, escapeHtml, italic, joinLines, link, truncate } from './html.js';
import type { TgChatRecord } from './chatStore.js';
import {
  ALERT_CATALOG,
  ALERT_TYPES,
  isMuted,
  subscribedTypes,
  type TgAlertType,
  type TgChatSettings,
} from './alertPolicy.js';
import type { PendingDigest } from './digest.js';

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

/**
 * `/start` — registration confirmation.
 *
 * The wording here is load-bearing. The previous version said "contract
 * detections will land here", because they did: registration switched them on.
 * That is what flooded a live group. Registration now subscribes a chat to
 * NOTHING, so this card's job is to say so plainly and point at the one command
 * that changes it — a group must never be surprised by the first alert.
 */
export function renderStart(chatTitle: string | null, isGroup: boolean): string {
  return joinLines([
    bold('OCT is listening. 👀'),
    '',
    isGroup
      ? `This chat${chatTitle ? ` (${name(chatTitle)})` : ''} is registered, and it is subscribed to nothing yet — the bot will stay quiet until you turn an alert on.`
      : 'This chat is registered, and it is subscribed to nothing yet — the bot will stay quiet until you turn an alert on.',
    '',
    `Run ${code('/alerts')} to see what is available and how loud each one is.`,
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
    `${code('/start')} — register this chat (subscribes to nothing)`,
    `${code('/alerts')} — see and change what this chat receives`,
    `${code('/help')} — this list`,
    `${code('/status')} — what this chat is registered for`,
    `${code('/token <address> [chain]')} — market snapshot from OCT enrichment`,
    '',
    italic('In a group, add @thebotname to any command if other bots are present.'),
    '',
    footer(),
  ]);
}

/** How one delivery mode reads in /alerts and /status. */
function deliveryLabel(settings: TgChatSettings, type: TgAlertType): string {
  switch (settings.alerts[type]) {
    case 'instant':
      return 'on · every event';
    case 'digest':
      return 'on · digest';
    default:
      return 'off';
  }
}

/** The one line that says how a chat gets out of a circuit-breaker mute. */
function muteNotice(settings: TgChatSettings, now: number): string[] {
  if (!isMuted(settings, now)) return [];
  const until = new Date(settings.mutedUntil).toISOString().replace('T', ' ').slice(0, 16);
  return [
    `${bold('⛔ Muted:')} ${escapeHtml(settings.mutedReason ?? 'too many alerts')} — until ${escapeHtml(`${until} UTC`)}.`,
    `Alerts are paused. Run ${code('/alerts unmute')} to resume, after turning the loud class off.`,
  ];
}

/**
 * `/alerts` — the subscription board.
 *
 * Every class is listed with its real volume, including the ones that are off,
 * because the honest version of this card is the thing that stops somebody
 * subscribing to a feed they have not been warned about.
 */
export function renderAlertSettings(
  settings: TgChatSettings,
  opts: { digestMinutes: number; maxPerHour: number; now: number },
): string {
  const rows = ALERT_TYPES.map((type) => {
    const spec = ALERT_CATALOG[type];
    return joinLines([
      `${bold(`${spec.label}:`)} ${escapeHtml(deliveryLabel(settings, type))}  ${code(spec.keyword)}`,
      italic(spec.volumeNote),
    ]);
  });

  return joinLines([
    bold('OCT alert subscriptions'),
    ...muteNotice(settings, opts.now),
    '',
    ...rows,
    '',
    `${code('/alerts on <type>')} — subscribe (batched digest)`,
    `${code('/alerts off <type>')} — unsubscribe`,
    '',
    italic(
      `Digests go out every ${opts.digestMinutes} min, and this chat is capped at ${opts.maxPerHour} messages an hour whatever the feed does.`,
    ),
    '',
    footer(),
  ]);
}

/** The reply to a successful `/alerts on|off`. */
export function renderAlertChange(
  type: TgAlertType,
  delivery: 'off' | 'digest' | 'instant',
  digestMinutes: number,
): string {
  const spec = ALERT_CATALOG[type];
  if (delivery === 'off') {
    return joinLines([`${bold(spec.label)} are off for this chat.`, footer()]);
  }
  return joinLines([
    `${bold(spec.label)} are on for this chat.`,
    delivery === 'digest'
      ? escapeHtml(`Batched into one summary every ${digestMinutes} minutes.`)
      : escapeHtml('Delivered as they happen.'),
    italic(spec.volumeNote),
    footer(),
  ]);
}

/**
 * The reply to `/alerts on contracts` without the confirmation word.
 *
 * Contract detection is the class that caused the incident this policy exists
 * for, so subscribing to it costs a second command. The warning states the real
 * volume rather than a generic "are you sure".
 */
export function renderVolumeWarning(type: TgAlertType): string {
  const spec = ALERT_CATALOG[type];
  return joinLines([
    `${bold('⚠️ ' + spec.label)} is the loudest thing OCT emits.`,
    '',
    italic(spec.volumeNote),
    '',
    `If you want it anyway, run ${code(`/alerts on ${spec.keyword} confirm`)}.`,
    '',
    footer(),
  ]);
}

/** The reply to a malformed `/alerts …`. */
export function renderAlertsUsage(problem: string | null): string {
  return joinLines([
    problem ? escapeHtml(problem) : null,
    problem ? '' : null,
    bold('Usage'),
    `${code('/alerts')} — what this chat receives`,
    `${code('/alerts on <type>')} — subscribe`,
    `${code('/alerts off <type>')} — unsubscribe`,
    `${code('/alerts unmute')} — lift an automatic mute`,
    '',
    `${bold('Types:')} ${ALERT_TYPES.map((t) => code(ALERT_CATALOG[t].keyword)).join(' · ')}`,
    '',
    footer(),
  ]);
}

/** `/status` — registration state, subscriptions, mute, alert routing, plan. */
export function renderStatus(
  record: TgChatRecord | null,
  opts: { alertsRouted: boolean; allowlisted: boolean; now: number },
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

  const subscribed = subscribedTypes(record.settings);

  return joinLines([
    bold('OCT bot status'),
    // The mute goes first and says how to lift it: a chat whose alerts stopped
    // should learn why in the first line, not after scrolling past its plan.
    ...muteNotice(record.settings, opts.now),
    '',
    `${bold('Chat:')} ${name(record.title, record.chatType)} (${escapeHtml(record.chatType)})`,
    `${bold('Active:')} ${record.enabled ? 'yes' : 'no'}`,
    subscribed.length === 0
      ? `${bold('Alerts:')} none — this chat is subscribed to nothing`
      : `${bold('Alerts:')} ${escapeHtml(subscribed.map((t) => `${ALERT_CATALOG[t].label} (${deliveryLabel(record.settings, t)})`).join(', '))}`,
    subscribed.length === 0 ? italic('Run /alerts to choose what lands here.') : null,
    // Honest about the one case where a chat is subscribed but will never
    // receive anything: no alert source is bound to it. Silently "on" would be
    // the worse answer.
    opts.alertsRouted || subscribed.length === 0
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
 * One alert, as a full Telegram card. The per-event delivery format.
 *
 * Addresses are `<code>` so they are tap-to-copy — the single most useful
 * property this card can have, since the next thing anyone does with a fresh
 * mint is paste it into a chart or a bot. At most three are shown: a message
 * that scanned more than three is a list, not a call.
 *
 * `title` is the alert class's label, so a missed runner and a contract scan
 * are visibly different things in a chat rather than two identical cards.
 */
export function renderAlertCard(title: string, view: ContractAlertView): string {
  // Plain text until the line that composes it — see clampName.
  const where = [view.guildName, view.channelName]
    .filter((v): v is string => !!v)
    .map((v) => clampName(v));
  const body = view.content.trim();
  const addresses = view.addresses.slice(0, 3);
  const overflow = view.addresses.length - addresses.length;

  return joinLines([
    bold(`💠 ${title}`),
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

/** A contract detection, as a Telegram card. The historic entry point. */
export function renderContractAlert(view: ContractAlertView): string {
  return renderAlertCard('Contract scan', view);
}

/** The subset of a market-cap crossing this card renders. */
export interface McapCrossView {
  address: string;
  /** GeckoTerminal network id — 'solana' | 'bsc' | 'robinhood'. */
  network: string;
  symbol: string | null;
  mcapUsd: number;
  targetUsd: number;
  liquidityUsd: number | null;
  liquidityRatio: number | null;
  /** Non-blocking gate caveats, e.g. `honeypotUnknown`. Absent = clean pass. */
  caveats?: string[];
}

/**
 * A market-cap crossing, as a Telegram card.
 *
 * It does NOT reuse renderAlertCard. That card's frame is "somebody said
 * something somewhere" — From, Where, a quoted message body — and every one of
 * those fields would be empty here, because no human posted anything: a poller
 * watched the chain. Filling them with dashes would make a real signal look
 * like a malformed one.
 *
 * LIQUIDITY IS ON THE CARD, not just in the gates. The gate answers "is this
 * exitable at all"; the number answers "how big can I be", which is the next
 * question anyone asks and is the difference between an alert that gets acted
 * on and one that gets screenshotted. The chain goes on the card for the same
 * reason a wrong-chain address is a wasted click.
 */
export function renderMcapCrossCard(view: McapCrossView): string {
  const ticker = clampName((view.symbol ?? '').toUpperCase().replace(/^\$/, ''), '');
  const heading = ticker !== '' ? `📈 $${ticker} crossed ${compactUsd(view.targetUsd)}` : `📈 Crossed ${compactUsd(view.targetUsd)}`;
  const depth =
    view.liquidityUsd != null
      ? `${compactUsd(view.liquidityUsd)}${view.liquidityRatio != null ? ` (${(view.liquidityRatio * 100).toFixed(1)}% of mcap)` : ''}`
      : 'unknown';

  // An unevaluated honeypot check is stated, not swallowed. See
  // GateVerdict.caveats: the EVM gate deliberately passes a null `is_honeypot`
  // (abstaining there would silence BNB almost entirely), so the ONLY honest
  // place to put that uncertainty is in front of the person about to buy.
  const caveated = view.caveats?.includes('honeypotUnknown') === true;

  return joinLines([
    bold(heading),
    `${bold('MCap:')} ${escapeHtml(compactUsd(view.mcapUsd))}`,
    `${bold('Liquidity:')} ${escapeHtml(depth)}`,
    `${bold('Chain:')} ${escapeHtml(revivalNetworkLabel(view.network))}`,
    ...(caveated ? [`${bold('⚠ Honeypot:')} ${escapeHtml('not evaluated — verify before buying')}`] : []),
    '',
    code(view.address),
    link('Chart ↗', buildRevivalContractUrl(view.address, view.network, LINK_TEMPLATES)),
    footer(caveated ? 'Scam-filtered · honeypot status unknown' : 'Scam-filtered'),
  ]);
}

/** One line of a digest for a market-cap crossing. Terse; keeps the address. */
export function mcapCrossDigestLine(view: McapCrossView): string {
  const ticker = clampName((view.symbol ?? '').toUpperCase().replace(/^\$/, ''), '');
  const head = ticker !== '' ? escapeHtml(`$${ticker}`) : code(view.address);
  return (
    `${escapeHtml(ALERT_CATALOG.mcapCross.label)} — ${head} ` +
    escapeHtml(`· ${compactUsd(view.mcapUsd)} · ${revivalNetworkLabel(view.network)}`)
  );
}

/**
 * One line of a digest.
 *
 * Deliberately terse — a digest of ten of these has to stay readable on a phone
 * — but it keeps the address as tap-to-copy `<code>`, because that is the one
 * thing a reader actually wants out of it. The full card is what per-event
 * delivery is for.
 */
export function digestLineFor(type: TgAlertType, view: ContractAlertView): string {
  const address = view.addresses[0];
  const where = clampName(view.channelName ?? view.guildName, '');
  const who = clampName(view.author, '');

  const tail = [who, where].filter((v) => v !== '').join(' · ');
  const head = address ? code(address) : escapeHtml(truncate(view.reason, 90));

  return `${escapeHtml(ALERT_CATALOG[type].label)} — ${head}${tail ? ` ${escapeHtml(`· ${tail}`)}` : ''}`;
}

/**
 * The batched summary. One message, however many events went into it.
 *
 * A repeated line carries `×N` rather than repeating: on a busy feed the same
 * mint crosses several channels within seconds, and listing it five times would
 * be the flood again at a slower cadence.
 */
export function renderDigest(pending: PendingDigest, now: number): string {
  const minutes = Math.max(1, Math.round((now - pending.since) / 60_000));
  const events = pending.lines.reduce((sum, l) => sum + l.count, 0);

  return joinLines([
    bold(`💠 OCT digest — ${events} alert${events === 1 ? '' : 's'}`),
    italic(`Last ${minutes} min`),
    '',
    ...pending.lines.map((l) => (l.count > 1 ? `${l.line} ${bold(`×${l.count}`)}` : l.line)),
    pending.dropped > 0 ? italic(`+${pending.dropped} more not shown`) : null,
    '',
    footer(),
  ]);
}
