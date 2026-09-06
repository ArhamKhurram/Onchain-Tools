// The /start panel: one persistent card with an inline keyboard, and every
// decision it makes, as pure functions.
//
// WHY A PANEL AT ALL. /start used to answer with a paragraph ending in "run
// /alerts". The repo owner sent /start, read it, and asked for "a dashboard
// kinda thing similar to other bots" — which is the honest signal that a wall
// of prose is not a product surface. Trading bots (Bloom, Trojan, BONKbot,
// Maestro) all converged on the same shape for a reason: a status block that
// answers "what is this thing doing for me right now" plus a button grid that
// makes the next action one tap. This is that shape, for what OCT actually is.
//
// WHAT IT IS NOT. OCT holds no keys, no balance and no custody, so none of the
// buttons those bots ship (Withdraw, Bridge, Copy Trade, PnL) have anything
// behind them here. Every button below maps to a capability that already exists
// in this directory: the alert catalog (alertPolicy.ts), the chat roster
// (chatStore.ts), the digest buffer (digest.ts), the outbound guard (guard.ts),
// the source binding (source.ts) and the command list. A button with nothing
// behind it is worse than no button, because it is a promise.
//
// THE FLOOD RULE SURVIVES THE REDESIGN. alertPolicy.ts exists because the first
// release subscribed a chat at /start and flooded a live group. A panel is a
// tempting place to undo that by accident — a "get started" default, a helpful
// pre-check. So:
//
//   • `panelHomeSettings()` IS DEFAULT_CHAT_SETTINGS. Opening the panel writes
//     nothing and subscribes nothing; the home card renders "none" and says so.
//   • The keyboard makes subscribing ONE TAP INSTEAD OF ONE TYPED COMMAND, and
//     nothing else. `nextDelivery` walks the same off → digest → instant cycle
//     that `/alerts on` does, digest first, and refuses `instant` on any class
//     whose spec forbids it.
//   • The class that caused the incident still costs a second, deliberate act:
//     pressing it opens a confirmation card, and only the button ON THAT CARD
//     carries a `set`. There is no callback token that subscribes to contracts
//     in one press, which is a property of the encoding rather than of the
//     rendering — see the test.
//
// WHY THE PERMISSION DECISION LIVES HERE AND NOT IN THE HANDLER. A callback
// query carries the PRESSING user, who in a group is any member, not the person
// who opened the panel. Getting that wrong means any member of any group can
// retune somebody else's alert subscriptions. `decidePanelPress` is therefore a
// pure function of (action, actor) so the rule is a table in a unit test rather
// than an inference about an async handler; callbacks.ts's only job is to
// gather the two facts it needs (allowlisted? admin?) and obey the answer.
//
// Everything in this file is PURE: no clock beyond an injected `now`, no I/O,
// no module state.

import {
  ALERT_CATALOG,
  ALERT_TYPES,
  DEFAULT_CHAT_SETTINGS,
  isMuted,
  subscribedTypes,
  type TgAlertDelivery,
  type TgAlertType,
  type TgAlertTypeSpec,
  type TgChatSettings,
} from './alertPolicy.js';
import type { TgChatRecord } from './chatStore.js';
import { COMMAND_GROUPS } from './commandCatalog.js';
import { bold, code, escapeHtml, italic, joinLines, link, truncate } from './html.js';
import { groupMentionNote } from './identity.js';
import { decideChatWrite } from './permissions.js';
import { footer } from './render.js';
import type { TgChat, TgInlineKeyboardButton, TgInlineKeyboardMarkup } from './types.js';

/** The console the panel links to. Env-overridable; the deployed default. */
const DEFAULT_CONSOLE_URL = 'https://www.onchaintools.tech/dashboard';

const CONSOLE_URL_ENV = ['TG_BOT_CONSOLE_URL', 'OCT_TG_BOT_CONSOLE_URL'] as const;

/**
 * The console link, or null when it is configured to something that is not an
 * http(s) URL.
 *
 * `link()` already degrades a non-http URL to plain text, but an inline-keyboard
 * button with a bad `url` is a 400 on the send — which would cost the whole
 * panel — so the check happens here too and simply drops the Resources block.
 */
export function readConsoleUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of CONSOLE_URL_ENV) {
    const raw = env[key]?.trim();
    if (raw) return /^https?:\/\//i.test(raw) ? raw : null;
  }
  return DEFAULT_CONSOLE_URL;
}

// --- callback data -----------------------------------------------------------

/**
 * The encoding version.
 *
 * Panels persist: a card sent today is still pressable in 48 hours, across any
 * number of deploys. A version prefix means a future change of grammar makes
 * old tokens PARSE AS NULL — answered with "this panel is out of date, run
 * /start" — rather than parsing as something subtly different. Bumping it is
 * the cheap, correct move for any change to the shape below.
 */
const TOKEN_VERSION = 'p1';

const TOKEN_SEPARATOR = ':';

/** Telegram's hard cap on `callback_data`, in BYTES of UTF-8. */
export const MAX_CALLBACK_DATA_BYTES = 64;

/** The sub-cards the panel can show. `home` is what /start opens on. */
export type PanelView = 'home' | 'alerts' | 'digest' | 'recent' | 'status' | 'help';

const PANEL_VIEWS: readonly PanelView[] = ['home', 'alerts', 'digest', 'recent', 'status', 'help'];

function isPanelView(value: string): value is PanelView {
  return (PANEL_VIEWS as readonly string[]).includes(value);
}

function isAlertType(value: string): value is TgAlertType {
  return (ALERT_TYPES as readonly string[]).includes(value);
}

function isDelivery(value: string): value is TgAlertDelivery {
  return value === 'off' || value === 'digest' || value === 'instant';
}

/**
 * What one press asks for.
 *
 * `view` and `refresh` are the same render with different budgets — see
 * `isPanelRead` and the rate limiter in callbacks.ts — so they stay distinct
 * kinds rather than one kind with a flag.
 */
export type PanelAction =
  | { kind: 'view'; view: PanelView }
  | { kind: 'refresh'; view: PanelView }
  | { kind: 'confirm'; type: TgAlertType }
  | { kind: 'set'; type: TgAlertType; delivery: TgAlertDelivery }
  | { kind: 'unmute' }
  | { kind: 'close' };

/** Serialize one action into `callback_data`. */
export function encodePanelAction(action: PanelAction): string {
  const parts: string[] = [TOKEN_VERSION];
  switch (action.kind) {
    case 'view':
      parts.push('v', action.view);
      break;
    case 'refresh':
      parts.push('r', action.view);
      break;
    case 'confirm':
      parts.push('c', action.type);
      break;
    case 'set':
      parts.push('s', action.type, action.delivery);
      break;
    case 'unmute':
      parts.push('u');
      break;
    case 'close':
      parts.push('x');
      break;
  }
  return parts.join(TOKEN_SEPARATOR);
}

/**
 * Parse `callback_data` back into an action, or null.
 *
 * THIS IS UNTRUSTED INPUT. Telegram echoes back whatever byte string the button
 * carried, and nothing stops a crafted client sending a callback query for a
 * button that was never rendered — the id is not a capability. So this is a
 * strict whitelist at every position: the version must match exactly, the verb
 * must be one of six single letters, and each argument must be a member of a
 * closed set (`PANEL_VIEWS`, `ALERT_TYPES`, the three delivery literals).
 * Nothing parsed here is ever concatenated into a query, a path or a template;
 * the return value is a tagged union the handler switches on.
 *
 * A rejected token is a null, not a throw: a stale panel from two deploys ago
 * is an expected condition and gets a polite answer, not a logged error.
 */
export function parsePanelAction(raw: string | undefined | null): PanelAction | null {
  if (typeof raw !== 'string') return null;
  // Bound the work before splitting: a 64-byte cap means a longer string cannot
  // have come from a button we sent, whatever it decodes to.
  if (raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_CALLBACK_DATA_BYTES) return null;

  const parts = raw.split(TOKEN_SEPARATOR);
  if (parts[0] !== TOKEN_VERSION) return null;

  const verb = parts[1];
  const arg1 = parts[2];
  const arg2 = parts[3];

  switch (verb) {
    case 'v':
      if (parts.length !== 3 || arg1 === undefined || !isPanelView(arg1)) return null;
      return { kind: 'view', view: arg1 };
    case 'r':
      if (parts.length !== 3 || arg1 === undefined || !isPanelView(arg1)) return null;
      return { kind: 'refresh', view: arg1 };
    case 'c':
      if (parts.length !== 3 || arg1 === undefined || !isAlertType(arg1)) return null;
      return { kind: 'confirm', type: arg1 };
    case 's':
      if (parts.length !== 4 || arg1 === undefined || arg2 === undefined) return null;
      if (!isAlertType(arg1) || !isDelivery(arg2)) return null;
      // A stored-preference rule enforced at the DOOR as well as in
      // readSettings: a token asking for per-event delivery on a class whose
      // spec forbids it is refused outright rather than silently demoted, for
      // the same reason `/alerts on … now` is (see parseAlertsCommand).
      if (arg2 === 'instant' && !ALERT_CATALOG[arg1].instantAllowed) return null;
      return { kind: 'set', type: arg1, delivery: arg2 };
    case 'u':
      return parts.length === 2 ? { kind: 'unmute' } : null;
    case 'x':
      return parts.length === 2 ? { kind: 'close' } : null;
    default:
      return null;
  }
}

// --- permission --------------------------------------------------------------

/** Everything `decidePanelPress` is allowed to know about a press. */
export interface PanelActor {
  /** The chat the panel lives in. */
  chatId: number;
  chatType: TgChat['type'];
  /** The PRESSING user's id — not the panel's opener. */
  userId: number;
  /** Is this chat served at all? `isChatAllowed(chatId, readAllowedChatIds())`. */
  chatAllowed: boolean;
  /**
   * Is the presser 'creator' or 'administrator' here?
   *
   * Resolved by getChatMember, and FALSE whenever that call failed — an
   * unanswerable permission question is a "no", never a "probably".
   */
  isAdmin: boolean;
}

export type PanelPressVerdict =
  | { allow: true }
  | { allow: false; reason: 'chat_not_allowed' | 'not_owner' | 'not_admin'; message: string };

/**
 * Does an action CHANGE something other people in the chat can see?
 *
 * Three do: `set` retunes the chat's alert subscriptions, `unmute` lifts the
 * circuit breaker's protection, and `close` edits away a shared message. The
 * rest render a different card into the same message and are read-only.
 *
 * `confirm` is deliberately on the read side: it only shows the volume warning.
 * The subscribe is the `set` on that card, and that one is gated.
 */
export function isPanelWrite(action: PanelAction): boolean {
  return action.kind === 'set' || action.kind === 'unmute' || action.kind === 'close';
}

/** The complement — the actions whose only cost is a render and a store read. */
export function isPanelRead(action: PanelAction): boolean {
  return !isPanelWrite(action);
}

/**
 * May this user perform this action on this chat's panel?
 *
 * THE RULE, and why each clause is where it is:
 *
 *   1. An un-allowlisted chat is refused everything. access.ts already refuses
 *      it commands and never writes it a roster row; a button is not a way in.
 *      Checked first so a stranger cannot even enumerate the views.
 *
 *   2. In a PRIVATE chat, the chat id IS the user id. Anyone else pressing is
 *      impossible through a Telegram client, which is exactly why it is worth
 *      one line to reject: if it ever happens, the request is forged.
 *
 *   3. In a GROUP, a WRITE requires 'creator' or 'administrator'. This is the
 *      clause the whole file is about — the panel sits in a shared message that
 *      every member can tap, and the alternative is that any member can
 *      subscribe the room to OCT's loudest event class or lift a mute the
 *      circuit breaker imposed to protect them.
 *
 *   4. In a group, READS are open to any member. Telegram only delivers a
 *      callback query to us if the presser can see the message, so membership
 *      is already established, and a member who wants to know what the room is
 *      subscribed to should not have to ask an admin. The reads cost one
 *      column-scoped row read behind a per-chat rate limit (callbacks.ts) —
 *      that limit, not this rule, is what bounds them.
 *
 * Anonymous group admins post as the group, but a CALLBACK query always carries
 * a real user, so there is no anonymous-admin hole here to close.
 *
 * Clauses 2 and 3 are NOT written out here any more: they are `decideChatWrite`
 * in permissions.ts, which the typed commands now call as well. The panel had
 * this rule and the commands did not, which made `/alerts on contracts confirm`
 * from any group member a way around a button any group member could not press.
 * One function, both surfaces.
 */
export function decidePanelPress(action: PanelAction, actor: PanelActor): PanelPressVerdict {
  if (!actor.chatAllowed) {
    return {
      allow: false,
      reason: 'chat_not_allowed',
      message: 'This OCT bot is limited to approved chats.',
    };
  }

  // A read in a group is open to any member (clause 4). Everything else — every
  // write, and every action in a private chat — goes to the shared rule.
  if (isPanelRead(action) && actor.chatType !== 'private') return { allow: true };

  return decideChatWrite(actor);
}

// --- subscription cycle ------------------------------------------------------

/**
 * The delivery a class moves to when its button is pressed.
 *
 *   off → digest → (instant, where the class allows it) → off
 *
 * DIGEST IS ALWAYS THE FIRST STOP. One tap can only ever get you the batched
 * summary; per-event delivery is a second, separate tap, and only on the two
 * classes whose upstream bounds their rate (see TgAlertTypeSpec.instantAllowed).
 * That is the same order `/alerts on <class>` has, so the button and the
 * command cannot disagree about what "subscribe" means.
 */
export function nextDelivery(spec: TgAlertTypeSpec, current: TgAlertDelivery): TgAlertDelivery {
  if (current === 'off') return 'digest';
  if (current === 'digest') return spec.instantAllowed ? 'instant' : 'off';
  return 'off';
}

/**
 * Does pressing this class's button need the confirmation card first?
 *
 * Only when turning something ON, only for a class whose spec demands it, and
 * only from 'off' — cycling digest → instant → off on a class already
 * subscribed is not the destructive act the confirmation exists to slow down.
 * Same three conditions as commands/alerts.ts, deliberately.
 */
export function needsConfirmation(spec: TgAlertTypeSpec, current: TgAlertDelivery): boolean {
  return current === 'off' && spec.requiresConfirmation;
}

/**
 * The settings a chat has when the panel first opens: none.
 *
 * A named re-export rather than a value of its own, so there is exactly one
 * fail-closed default in the codebase and the panel's test asserts against the
 * SAME object the fan-out reads.
 */
export function panelHomeSettings(): TgChatSettings {
  return DEFAULT_CHAT_SETTINGS;
}

// --- keyboards ---------------------------------------------------------------

function button(text: string, action: PanelAction): TgInlineKeyboardButton {
  return { text, callback_data: encodePanelAction(action) };
}

/** The state a keyboard needs to lay itself out. No I/O; the caller gathers it. */
export interface PanelState {
  view: PanelView;
  /** Null when the chat has no roster row — storage down, or never registered. */
  record: TgChatRecord | null;
  settings: TgChatSettings;
  /** Is an OCT alert source bound to this chat? Null when unknown. */
  alertsRouted: boolean | null;
  digestMinutes: number;
  maxPerHour: number;
  /** Messages the outbound guard has counted against this chat's hour. */
  usedThisHour: number;
  /** Digest lines buffered for this chat right now, newest last. */
  pending: { line: string; count: number }[];
  /** Events the digest buffer refused because this chat was full. */
  pendingDropped: number;
  now: number;
}

/** How one class's button reads: label plus the state pressing it will leave. */
function alertButtonLabel(spec: TgAlertTypeSpec, delivery: TgAlertDelivery): string {
  const mark = delivery === 'off' ? '○' : delivery === 'instant' ? '⚡' : '●';
  const suffix = delivery === 'off' ? 'off' : delivery === 'instant' ? 'every event' : 'digest';
  return `${mark} ${spec.label} — ${suffix}`;
}

/**
 * The keyboard for one view.
 *
 * HOME IS A GRID, SUB-VIEWS ARE A LIST. The five home destinations are peers
 * and read fastest two-up; the alert classes are a vertical list because each
 * label carries its current state and a truncated "Market-cap cros…" would
 * defeat the point of putting the state on the button.
 *
 * Refresh is present on every view and always refreshes THAT view, so the card
 * a person is reading is the card that updates. Close is home-only: closing
 * from a sub-view would look like a mis-tap of Back.
 */
export function buildPanelKeyboard(state: PanelState): TgInlineKeyboardMarkup {
  const rows: TgInlineKeyboardButton[][] = [];

  if (state.view === 'home') {
    rows.push([
      button('🔔 Alerts', { kind: 'view', view: 'alerts' }),
      button('📊 Status', { kind: 'view', view: 'status' }),
    ]);
    rows.push([
      button('🗞 Digest', { kind: 'view', view: 'digest' }),
      button('🕘 Queued', { kind: 'view', view: 'recent' }),
    ]);
    rows.push([
      button('❓ Help', { kind: 'view', view: 'help' }),
      button('↻ Refresh', { kind: 'refresh', view: 'home' }),
    ]);
    // Only offered when there is a mute to lift — a button that would answer
    // "this chat is not muted" is a button that should not be on the card.
    if (isMuted(state.settings, state.now)) {
      rows.push([button('🔊 Unmute alerts', { kind: 'unmute' })]);
    }
    rows.push([button('✕ Close', { kind: 'close' })]);
    return { inline_keyboard: rows };
  }

  if (state.view === 'alerts') {
    for (const type of ALERT_TYPES) {
      const spec = ALERT_CATALOG[type];
      const current = state.settings.alerts[type];
      // The confirmation card is a different token from the subscribe, so the
      // loud class is unreachable in one press by construction.
      const action: PanelAction = needsConfirmation(spec, current)
        ? { kind: 'confirm', type }
        : { kind: 'set', type, delivery: nextDelivery(spec, current) };
      rows.push([button(alertButtonLabel(spec, current), action)]);
    }
  }

  rows.push([
    button('↩ Back', { kind: 'view', view: 'home' }),
    button('↻ Refresh', { kind: 'refresh', view: state.view }),
  ]);
  return { inline_keyboard: rows };
}

/**
 * The keyboard on the confirmation card.
 *
 * The subscribe button says what it costs rather than "Yes" — a person who
 * taps past a warning should have read the consequence on the thing they tapped.
 */
export function buildConfirmKeyboard(type: TgAlertType): TgInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('⚠️ Subscribe anyway (digest)', { kind: 'set', type, delivery: 'digest' })],
      [button('↩ Back', { kind: 'view', view: 'alerts' })],
    ],
  };
}

// --- cards -------------------------------------------------------------------

/** `HH:MM UTC`, the panel's "last updated" stamp. */
function stampUtc(now: number): string {
  return `${new Date(now).toISOString().slice(11, 16)} UTC`;
}

function deliveryWord(delivery: TgAlertDelivery): string {
  return delivery === 'instant' ? 'every event' : delivery === 'digest' ? 'digest' : 'off';
}

/** The subscription summary line, in the one voice both cards use. */
function subscriptionLine(state: PanelState): string {
  if (!state.record) return `${bold('Alerts:')} ${escapeHtml('unknown — OCT storage is unavailable')}`;
  const subscribed = subscribedTypes(state.settings);
  if (subscribed.length === 0) return `${bold('Alerts:')} ${escapeHtml('none — nothing is turned on')}`;
  return (
    `${bold('Alerts:')} ` +
    escapeHtml(
      subscribed
        .map((t) => `${ALERT_CATALOG[t].label} (${deliveryWord(state.settings.alerts[t])})`)
        .join(', '),
    )
  );
}

function muteLines(state: PanelState): (string | null)[] {
  if (!isMuted(state.settings, state.now)) return [];
  const until = new Date(state.settings.mutedUntil).toISOString().replace('T', ' ').slice(0, 16);
  return [
    `${bold('⛔ Muted:')} ${escapeHtml(state.settings.mutedReason ?? 'too many alerts')} — until ${escapeHtml(`${until} UTC`)}.`,
  ];
}

/** The Resources block. Omitted entirely when no valid console URL is set. */
function resourceLines(consoleUrl: string | null): (string | null)[] {
  if (!consoleUrl) return [];
  return ['', bold('Resources'), `${link('Open the OCT console ↗', consoleUrl)}`];
}

/**
 * The home card.
 *
 * The status block answers, in order, the four questions a person opening this
 * actually has: what am I subscribed to, how will it arrive, how loud can it
 * get, and is anything wired up at all. Every one of them is a field that can
 * be UNKNOWN — a Supabase outage costs the roster read — and each renders as
 * "unknown" rather than as a plausible-looking default, because a panel that
 * cheerfully reports "none" during an outage is a panel that lies about a
 * subscription somebody is paying attention to.
 */
export function renderPanelHome(state: PanelState, consoleUrl: string | null): string {
  const title = state.record?.title?.trim();
  const where = state.record ? `${title ? `${truncate(title, 48)} · ` : ''}${state.record.chatType}` : null;

  return joinLines([
    bold('OCT 👀 — control panel'),
    where ? italic(where) : null,
    ...muteLines(state),
    '',
    subscriptionLine(state),
    `${bold('Delivery:')} ${escapeHtml(`digest every ${state.digestMinutes} min`)}`,
    `${bold('Ceiling:')} ${escapeHtml(`${state.usedThisHour} / ${state.maxPerHour} messages this hour`)}`,
    `${bold('Feed:')} ${escapeHtml(
      state.alertsRouted === null
        ? 'unknown'
        : state.alertsRouted
          ? 'connected to an OCT account'
          : 'no alert source bound yet',
    )}`,
    state.record ? `${bold('Plan:')} ${escapeHtml(state.record.plan)}` : null,
    ...resourceLines(consoleUrl),
    '',
    italic(`Last updated ${stampUtc(state.now)}`),
    footer(),
  ]);
}

/**
 * The alerts card.
 *
 * Every class is listed with its real volume even when it is off — the same
 * decision renderAlertSettings made, and for the same reason: the card that
 * warns you before you subscribe is the one that stops the next flood.
 */
export function renderPanelAlerts(state: PanelState): string {
  const rows = ALERT_TYPES.map((type) => {
    const spec = ALERT_CATALOG[type];
    return joinLines([
      `${bold(`${spec.label}:`)} ${escapeHtml(deliveryWord(state.settings.alerts[type]))}`,
      italic(spec.volumeNote),
    ]);
  });

  return joinLines([
    bold('🔔 Alert subscriptions'),
    ...muteLines(state),
    state.record ? null : italic('OCT storage is unavailable — these may be out of date.'),
    '',
    ...rows,
    '',
    italic('Tap a class to cycle it: off → digest → every event, where the class allows it.'),
    '',
    italic(`Last updated ${stampUtc(state.now)}`),
    footer(),
  ]);
}

/**
 * The digest card: how batching actually behaves for this chat.
 *
 * Both numbers are read from the live guard rather than from the config, so a
 * chat that has hit its ceiling can SEE that it has, instead of concluding the
 * bot is broken. That "why did it go quiet" question is the single most common
 * one a rate-limited bot produces.
 */
export function renderPanelDigest(state: PanelState): string {
  return joinLines([
    bold('🗞 Digest & limits'),
    '',
    `${bold('Interval:')} ${escapeHtml(`one summary every ${state.digestMinutes} min`)}`,
    `${bold('Hourly ceiling:')} ${escapeHtml(`${state.usedThisHour} of ${state.maxPerHour} used`)}`,
    `${bold('Queued now:')} ${escapeHtml(`${state.pending.length} line${state.pending.length === 1 ? '' : 's'}`)}`,
    '',
    italic(
      'Digest is the default for every class you turn on: many events become one message. Per-event delivery exists only for classes whose volume is bounded upstream.',
    ),
    '',
    italic(
      `Whatever the feed does, this chat receives at most ${state.maxPerHour} messages an hour. The overflow is dropped, not delayed.`,
    ),
    '',
    italic(`Last updated ${stampUtc(state.now)}`),
    footer(),
  ]);
}

/**
 * The queued card: what the NEXT digest will contain.
 *
 * Named "Queued" rather than "Recent" on purpose. A history of delivered alerts
 * would need a table this bot does not have, and inventing one to fill a button
 * would be the promise problem in the header. What genuinely exists is the
 * in-process digest buffer, which is both honest and the more useful of the two
 * — it answers "is something coming" rather than "what did I miss".
 */
export function renderPanelRecent(state: PanelState): string {
  const empty = state.pending.length === 0;
  return joinLines([
    bold('🕘 Queued for the next digest'),
    '',
    empty
      ? italic(
          subscribedTypes(state.settings).length === 0
            ? 'Nothing — this chat is subscribed to nothing yet.'
            : 'Nothing buffered right now.',
        )
      : null,
    ...state.pending.map((l) => (l.count > 1 ? `${l.line} ${bold(`×${l.count}`)}` : l.line)),
    state.pendingDropped > 0 ? italic(`+${state.pendingDropped} more not shown`) : null,
    '',
    italic(`Next flush is at most ${state.digestMinutes} min away.`),
    '',
    italic(`Last updated ${stampUtc(state.now)}`),
    footer(),
  ]);
}

/**
 * The status card: the states a registered chat can be silently quiet in.
 *
 * Same three as /status — subscribed to nothing, no source bound, auto-muted —
 * because each of them looks exactly like a broken bot from the chat's side.
 */
export function renderPanelStatus(state: PanelState): string {
  const record = state.record;
  if (!record) {
    return joinLines([
      bold('📊 Status'),
      '',
      escapeHtml('This chat has no OCT registration on record right now.'),
      italic('Either it has never run /start, or OCT storage is temporarily unavailable.'),
      '',
      `Run ${code('/start')} to register it.`,
      '',
      italic(`Last updated ${stampUtc(state.now)}`),
      footer(),
    ]);
  }

  const subscribed = subscribedTypes(state.settings);

  return joinLines([
    bold('📊 Status'),
    ...muteLines(state),
    '',
    `${bold('Chat:')} ${escapeHtml(truncate(record.title ?? record.chatType, 48))} (${escapeHtml(record.chatType)})`,
    `${bold('Active:')} ${record.enabled ? 'yes' : 'no'}`,
    subscriptionLine(state),
    subscribed.length > 0 && state.alertsRouted === false
      ? italic('No alert source is bound to this chat, so nothing will actually arrive.')
      : null,
    `${bold('Plan:')} ${escapeHtml(record.plan)}`,
    `${bold('Registered:')} ${escapeHtml(record.createdAt.slice(0, 10))}`,
    '',
    italic(`Last updated ${stampUtc(state.now)}`),
    footer(),
  ]);
}

/**
 * The help card. The command list, phrased for someone holding a panel.
 *
 * The list itself is COMMAND_GROUPS — the same table `/help` renders and the
 * same one Telegram's `/` menu is built from — so the panel can no longer be
 * the surface that forgets a command. It stays a distinct renderer because the
 * framing differs: this reader has buttons in front of them and needs to know
 * what the typed commands add, not what the bot is.
 *
 * `botUsername` reaches here from getMe through CallbackDeps; see identity.ts.
 */
export function renderPanelHelp(botUsername: string): string {
  const mention = groupMentionNote(botUsername);
  return joinLines([
    bold('❓ OCT bot commands'),
    ...COMMAND_GROUPS.flatMap((group): (string | null)[] => [
      '',
      bold(group.title),
      group.note ? italic(group.note) : null,
      ...group.commands.map((spec) => `${code(spec.usage)} — ${escapeHtml(spec.blurb)}`),
    ]),
    '',
    italic(
      'The buttons and the commands do the same things. Buttons are faster; commands work when someone else has the panel open.',
    ),
    mention ? italic(mention) : null,
    '',
    italic('No Telegram or Discord account of yours is connected, and none is needed.'),
    footer(),
  ]);
}

/**
 * The confirmation card for a class whose spec demands one.
 *
 * The twin of renderVolumeWarning, pointing at a button instead of at a second
 * typed command. The warning text is the SPEC's own volumeNote, so the panel
 * cannot understate a volume the catalog states honestly.
 */
export function renderPanelConfirm(type: TgAlertType): string {
  const spec = ALERT_CATALOG[type];
  return joinLines([
    `${bold(`⚠️ ${spec.label}`)} ${escapeHtml('is the loudest thing OCT emits.')}`,
    '',
    italic(spec.volumeNote),
    '',
    escapeHtml(
      'Subscribing sends it as a batched digest. You can turn it back off from the same button.',
    ),
    '',
    footer(),
  ]);
}

/** The one-line card a closed panel leaves behind. Nothing is deleted. */
export function renderPanelClosed(): string {
  return joinLines([italic('Panel closed.'), `Run ${code('/start')} to open it again.`]);
}

/**
 * The card for a press we cannot act on: a token from a previous encoding
 * version, or a panel Telegram no longer attaches a message to.
 */
export const PANEL_STALE_MESSAGE = 'This panel is out of date. Run /start to open a fresh one.';

/**
 * Render whichever card a view asks for.
 *
 * One switch, so a view added to PanelView is a compile error here rather than
 * a blank card in production.
 */
export function renderPanelView(
  state: PanelState,
  consoleUrl: string | null,
  botUsername: string,
): string {
  switch (state.view) {
    case 'home':
      return renderPanelHome(state, consoleUrl);
    case 'alerts':
      return renderPanelAlerts(state);
    case 'digest':
      return renderPanelDigest(state);
    case 'recent':
      return renderPanelRecent(state);
    case 'status':
      return renderPanelStatus(state);
    case 'help':
      return renderPanelHelp(botUsername);
  }
}

/** Every button the panel can ever emit. Exported so a test can bound them all. */
export function allPanelActions(): PanelAction[] {
  const actions: PanelAction[] = [{ kind: 'unmute' }, { kind: 'close' }];
  for (const view of PANEL_VIEWS) {
    actions.push({ kind: 'view', view });
    actions.push({ kind: 'refresh', view });
  }
  for (const type of ALERT_TYPES) {
    actions.push({ kind: 'confirm', type });
    for (const delivery of ['off', 'digest', 'instant'] as const) {
      if (delivery === 'instant' && !ALERT_CATALOG[type].instantAllowed) continue;
      actions.push({ kind: 'set', type, delivery });
    }
  }
  return actions;
}
