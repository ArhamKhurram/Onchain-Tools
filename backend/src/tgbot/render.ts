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
import { COMMAND_GROUPS } from './commandCatalog.js';
import { groupMentionNote } from './identity.js';

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

// `/start`'s card used to live here, as prose. It is now the control PANEL —
// a status block plus an inline keyboard — and it lives in panel.ts with the
// callback-data grammar and the permission rule it cannot be separated from.
// The wording that mattered survived the move intact: registration subscribes a
// chat to nothing, and the card says so in its first status line.

/**
 * `/help` — the command list, GROUPED BY WHAT SOMEBODY IS TRYING TO DO.
 *
 * The flat five-line version it replaces was readable only because there were
 * five commands; the ordering carried no information, so a reader with a
 * question ("why is this thing so loud") had to know which command answered it
 * before reading the list. The groups and their order live in
 * commandCatalog.ts, shared with the panel's Help view and Telegram's own `/`
 * menu, so adding a command cannot leave one of the three behind.
 *
 * `botUsername` comes from getMe — see identity.ts for why it is a parameter,
 * and what the card does when Telegram gave us no username.
 */
export function renderHelp(botUsername: string): string {
  return joinLines([
    bold('OCT bot commands'),
    ...COMMAND_GROUPS.flatMap((group): (string | null)[] => [
      '',
      bold(group.title),
      group.note ? italic(group.note) : null,
      ...group.commands.map((spec) => `${code(spec.usage)} — ${escapeHtml(spec.blurb)}`),
    ]),
    '',
    italic('In a DM, paste a bare contract address — no command needed.'),
    // Null when getMe returned no username: the line vanishes rather than
    // rendering a sentence with a hole where the handle should be.
    (() => {
      const note = groupMentionNote(botUsername);
      return note ? italic(note) : null;
    })(),
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
  /** Traded USD over 24h across all pools. Null/absent = not reported. */
  volume24hUsd?: number | null;
  /**
   * Estimated USD paid in trading fees/tax over 24h (volume x tax rate).
   * Null/absent = not computable — no volume, or no tax rate, which is every
   * Solana token. USD, because Axiom's ETH/SOL would need a native price this
   * pipeline does not hold.
   */
  totalFeesUsd?: number | null;
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
    // Volume earns a line only when it is KNOWN. Printing "unknown" beside a
    // number the reader can act on adds a row of noise to every card for the
    // minority of tokens DexScreener is quiet about; liquidity says "unknown"
    // because a gate depends on it, and volume's gate is off unless asked for.
    ...(view.volume24hUsd != null
      ? [`${bold('Vol 24h:')} ${escapeHtml(compactUsd(view.volume24hUsd))}`]
      : []),
    // Same rule as volume: a line only when the figure is KNOWN. "est." and
    // the explicit $ are both load-bearing — the reader knows this number from
    // Axiom, where it is exact and denominated in ETH/SOL, and neither is true
    // here. Absent on Solana by construction; see fees.ts.
    ...(view.totalFeesUsd != null
      ? [`${bold('Fees 24h:')} ${escapeHtml(`~${compactUsd(view.totalFeesUsd)} est.`)}`]
      : []),
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

/**
 * `3h ago`, `12m ago`, `just now`.
 *
 * Absolute UTC timestamps are what the mute notice uses, because "until when"
 * is a deadline somebody has to plan around. Recency is the opposite question —
 * a reader scanning crossings wants to know whether the top line is minutes or
 * days old, and "4h ago" answers it without arithmetic. Pure, clock-injected,
 * and it never renders a negative age: a clock skew that puts a row in the
 * future reads as "just now" rather than as "-3m ago".
 */
export function formatAgo(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One row of `/mcap`: what crossed, on which chain, and when. */
export interface RecentCrossingView {
  address: string;
  /** GeckoTerminal network id — 'solana' | 'bsc' | 'robinhood'. */
  network: string;
  /** The last market cap recorded for the token, not the value at the cross. */
  mcapUsd: number;
  /** Epoch ms of the alert. Always > 0; rows that never fired are not listed. */
  firedAt: number;
}

/**
 * `/mcap` — the last few market-cap crossings.
 *
 * WHAT THIS IS AND IS NOT. It reads `mcap_cross_state.fired_at`, which records
 * that a TOKEN crossed the threshold — not that any particular chat was sent
 * anything. So it lists crossings a chat may never have been subscribed for,
 * and the copy says "crossed", never "you missed". Inventing a per-chat
 * delivery history to make the second sentence true would need a table this bot
 * does not have, which is the same call renderPanelRecent made about "Queued".
 *
 * NO SYMBOL, ON PURPOSE. The state row holds an address, a chain and a number;
 * resolving five tickers means five token-catalog reads per invocation, on a
 * command any group member can run, against a database whose connection pool is
 * already the production constraint. The address is `<code>` and therefore
 * tap-to-copy, which is what a reader does with it next anyway.
 */
export function renderRecentCrossings(
  rows: RecentCrossingView[],
  opts: { targetUsd: number; now: number; enabled: boolean },
): string {
  if (!opts.enabled) {
    return joinLines([
      bold('📈 Market-cap crossings'),
      '',
      escapeHtml('The crossing poller is not running on this OCT instance.'),
      footer(),
    ]);
  }

  if (rows.length === 0) {
    return joinLines([
      bold('📈 Market-cap crossings'),
      '',
      italic(`Nothing has crossed ${compactUsd(opts.targetUsd)} on record yet.`),
      footer(),
    ]);
  }

  return joinLines([
    bold(`📈 Last ${rows.length} to cross ${compactUsd(opts.targetUsd)}`),
    '',
    ...rows.flatMap((row) => [
      `${bold(compactUsd(row.mcapUsd))} ${escapeHtml(
        `· ${revivalNetworkLabel(row.network)} · ${formatAgo(row.firedAt, opts.now)}`,
      )}`,
      `${code(row.address)}\n${link('Chart ↗', buildRevivalContractUrl(row.address, row.network, LINK_TEMPLATES))}`,
    ]),
    '',
    italic('Market cap is the latest reading, not the value at the cross.'),
    footer('Scam-filtered'),
  ]);
}

/**
 * `/queued` — what this chat's next digest will contain.
 *
 * The typed twin of the panel's Queued card, and it reads the SAME in-process
 * buffer through `peek` rather than `take`: rendering must never consume the
 * batch it is describing. It costs no storage read at all, which is why it can
 * be a command anyone in the room may run.
 */
export function renderQueued(
  view: { lines: { line: string; count: number }[]; dropped: number },
  opts: { digestMinutes: number; subscribed: number },
): string {
  const empty = view.lines.length === 0;
  return joinLines([
    bold('🕘 Queued for the next digest'),
    '',
    empty
      ? italic(
          opts.subscribed === 0
            ? 'Nothing — this chat is subscribed to nothing yet. Run /alerts to choose.'
            : 'Nothing buffered right now.',
        )
      : null,
    ...view.lines.map((l) => (l.count > 1 ? `${l.line} ${bold(`×${l.count}`)}` : l.line)),
    view.dropped > 0 ? italic(`+${view.dropped} more not shown`) : null,
    '',
    italic(`Next flush is at most ${opts.digestMinutes} min away.`),
    footer(),
  ]);
}

/** The reply to a successful `/mute`. States the deadline, not the duration. */
export function renderMuted(untilMs: number): string {
  const until = new Date(untilMs).toISOString().replace('T', ' ').slice(0, 16);
  return joinLines([
    `${bold('🔇 Muted.')} ${escapeHtml(`No alerts here until ${until} UTC.`)}`,
    italic('Subscriptions are untouched — /unmute resumes them early.'),
    footer(),
  ]);
}

/** The reply to a malformed `/mute …`. */
export function renderMuteUsage(problem: string | null): string {
  return joinLines([
    problem ? escapeHtml(problem) : null,
    problem ? '' : null,
    bold('Usage'),
    `${code('/mute')} — pause alerts for 1 hour`,
    `${code('/mute 30m')} · ${code('/mute 2h')} · ${code('/mute 1d')} — pause for that long`,
    `${code('/unmute')} — resume now`,
    '',
    italic('Muting changes nothing about what this chat is subscribed to.'),
    footer(),
  ]);
}
