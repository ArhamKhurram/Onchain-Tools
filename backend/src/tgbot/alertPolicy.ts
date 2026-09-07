// WHICH alerts a Telegram chat receives, and HOW they are delivered.
//
// THE INCIDENT THIS FILE EXISTS FOR. The first release wired the bot to
// contract detections and switched them ON at /start. Contract detection is
// OCT's highest-volume event by design — it fires on essentially every address
// that crosses the feed — so the first real group the bot joined was flooded
// ("why is the bot max pinging me nah gg"). The bot worked as built; the
// specification was wrong in two independent ways, and both are fixed here:
//
//   1. FAIL CLOSED. A chat that has just run /start is subscribed to NOTHING.
//      Every alert class is opt-in, per chat, by an explicit command. A bot
//      newly added to a group is silent until somebody deliberately turns
//      something on. Defaults that fail open are how one mis-specification
//      becomes a user's phone buzzing forty times.
//
//   2. DIGEST BY DEFAULT. Opting in gets you a periodic summary, not a message
//      per event. Eight detections is one ping. Per-event delivery exists, but
//      only for a class whose volume is bounded upstream (see instantAllowed).
//
// ONE CLASS DOES NOT COME THROUGH THAT SEAM AT ALL. 'mcapCross' is raised by a
// poller watching the chain, not by a message anybody posted, so it has no
// FrontendMessage and cannot be classified out of an AlertLike. It reaches this
// policy through TgAlertRouter.handleSignal instead — the SUBSCRIPTION, the
// guard, the circuit breaker and the digest are identical; only the way the
// event arrives differs. classifyAlert therefore never returns it, and that is
// correct rather than an omission.
//
// WHAT IS ACTUALLY AVAILABLE HERE. This is bounded by the seam, not by taste:
// WsServer.onAlert observes broadcastAlert, and exactly four alert types reach
// it (utils/frontendAlerts.ts, index.ts's keyword branch, missedRunnerPoller).
// Revival and breakout have their own frames (broadcastRevivalAlert /
// broadcastBreakoutAlert); pump_callout and fomo_trade are fanned out by
// j7/fanout.ts through sendToUser; signal_convergence is raised CLIENT-side and
// never reaches the backend at all. None of those pass through onAlert, so none
// of them can be offered without widening the seam — which is a separate change
// from stopping the flood.
//
// Everything in this file is PURE: no clock, no I/O, no module state. That is
// what lets the fail-closed guarantee be a unit test rather than a hope.

import type { FrontendMessage } from '../discord/types.js';

/** The alert shape WsServer.onAlert hands us (same as bot/alerts.ts). */
export interface AlertLike {
  type: string;
  message: FrontendMessage;
  reason: string;
}

/**
 * The alert classes a chat can subscribe to.
 *
 * Keyed by intent rather than by the wire `type` string, because one class
 * ('contract') deliberately spans two wire types — see isContractDetection.
 */
export type TgAlertType = 'octSignals' | 'missedRunner' | 'mcapCross' | 'keyword' | 'highlighted' | 'contract';

/**
 * How a subscribed class is delivered.
 *
 *   off     — not subscribed. The default for every class, in every chat.
 *   digest  — batched into one periodic summary message (see digest.ts).
 *   instant — one message per event. Only offered where upstream volume is
 *             bounded; see instantAllowed.
 */
export type TgAlertDelivery = 'off' | 'digest' | 'instant';

export const ALERT_TYPES: readonly TgAlertType[] = [
  'octSignals',
  'missedRunner',
  'mcapCross',
  'keyword',
  'highlighted',
  'contract',
] as const;

/** Rough upstream volume, used to decide what a chat is allowed to ask for. */
export type TgAlertVolume = 'low' | 'medium' | 'high' | 'extreme';

export interface TgAlertTypeSpec {
  type: TgAlertType;
  /** The word a user types: `/alerts on <keyword>`. */
  keyword: string;
  /** Other spellings accepted for the same class. */
  aliases: readonly string[];
  /** Short human label for /alerts and /status. */
  label: string;
  volume: TgAlertVolume;
  /** One honest line about how loud this is, shown before anyone opts in. */
  volumeNote: string;
  /**
   * May this class be delivered per-event?
   *
   * Only where the UPSTREAM bounds the rate — not where our own ceiling would
   * have to do all the work. missedRunner qualifies: the poller runs every
   * three minutes and a token that has alerted is on a 24h cooldown row
   * (alerts/missedRunnerPoller.ts), so the class is rare by construction. The
   * other three track the feed and are bounded by nothing.
   */
  instantAllowed: boolean;
  /**
   * Does opting in require a second, confirming command?
   *
   * True for the class that caused the incident. `/alerts on contracts` alone
   * returns the volume warning and changes nothing; it takes
   * `/alerts on contracts confirm` to actually subscribe. A destructive default
   * should cost more than one word.
   */
  requiresConfirmation: boolean;
}

/**
 * The catalog, loudest last.
 *
 * Ordering is deliberate: /alerts renders in this order, so the class a group
 * chat actually wants is the first thing read and the one that flooded a real
 * user is the last, under a warning.
 */
export const ALERT_CATALOG: Readonly<Record<TgAlertType, TgAlertTypeSpec>> = {
  octSignals: {
    type: 'octSignals',
    keyword: 'signals',
    // NOT 'alerts' — that collides with the /alerts command itself.
    aliases: ['signal', 'octsignals', 'oct_signals', 'scans', 'scan'],
    label: 'OCT Alerts',
    volume: 'medium',
    volumeNote:
      'Realtime algorithm-scan signals across SOL and EVM — bursty, and can be several within a minute when the market is moving.',
    // Earns per-event delivery because the class is a curated, operator-controlled
    // stream, not the raw feed: it is bounded upstream by whatever the source
    // channels post, and the hourly ceiling still clamps it to maxPerHour a chat.
    // It deliberately does NOT feed the circuit breaker (see alerts.ts route) so a
    // burst cannot auto-mute a chat's OTHER subscriptions.
    instantAllowed: true,
    requiresConfirmation: false,
  },
  missedRunner: {
    type: 'missedRunner',
    keyword: 'runners',
    aliases: ['runner', 'missed', 'missedrunner', 'missed_runner'],
    label: 'Missed runners',
    volume: 'low',
    volumeNote: 'Rare — a token alerts at most once per 24h, a few per day at most.',
    instantAllowed: true,
    requiresConfirmation: false,
  },
  mcapCross: {
    type: 'mcapCross',
    keyword: 'mcap',
    aliases: ['mcaps', 'marketcap', 'market_cap', 'mcapcross', '750k', 'crossings'],
    label: 'Market-cap crossings',
    volume: 'low',
    volumeNote:
      'A coin crossing $750K market cap on Solana, BNB or Robinhood, scam-filtered — roughly 1-2 an hour.',
    // The upstream bounds this, which is the only thing that earns per-event
    // delivery here. The $750K threshold is chosen so the whole market yields
    // ~30-80 crossings a day across three chains, and a token that alerts is on
    // a 24h cooldown row (mcapCross/poller.ts) — so, like missedRunner, the
    // class is rare BY CONSTRUCTION rather than by our own ceiling doing the
    // work. The DEFAULT is still digest; instant has to be asked for.
    instantAllowed: true,
    requiresConfirmation: false,
  },
  keyword: {
    type: 'keyword',
    keyword: 'keywords',
    aliases: ['keyword', 'keyword_match'],
    label: 'Keyword matches',
    volume: 'medium',
    volumeNote: 'Depends entirely on your keyword list — one broad word is a flood.',
    instantAllowed: false,
    requiresConfirmation: false,
  },
  highlighted: {
    type: 'highlighted',
    keyword: 'highlighted',
    aliases: ['highlight', 'highlights', 'highlighted_user'],
    label: 'Highlighted callers',
    volume: 'high',
    volumeNote: 'Every message from a highlighted caller, contract or not.',
    instantAllowed: false,
    requiresConfirmation: false,
  },
  contract: {
    type: 'contract',
    keyword: 'contracts',
    aliases: ['contract', 'ca', 'cas', 'contract_address'],
    label: 'Contract detections',
    volume: 'extreme',
    volumeNote:
      'Every contract address that crosses the feed — hundreds a day on a busy one. This is what flooded a live group; digest only, and it still will not be quiet.',
    instantAllowed: false,
    requiresConfirmation: true,
  },
};

/** Look a class up by anything a user might type. Null when it is not one. */
export function findAlertType(word: string): TgAlertTypeSpec | null {
  const needle = word.trim().toLowerCase();
  if (needle === '') return null;
  for (const type of ALERT_TYPES) {
    const spec = ALERT_CATALOG[type];
    if (spec.keyword === needle || spec.aliases.includes(needle)) return spec;
  }
  return null;
}

/**
 * Is this alert a contract detection?
 *
 * TWO WIRE TYPES, ONE SIGNAL. utils/frontendAlerts.ts emits `highlighted_user`
 * and RETURNS for a highlighted author, so a contract posted by a highlighted
 * user never produces a `contract_address` alert. Matching only the latter
 * would silently drop the highest-signal case in the product, so both count as
 * a contract detection — and, conversely, a highlighted user who posted no
 * address is the separate 'highlighted' class below.
 */
export function isContractDetection(alert: AlertLike): boolean {
  if (alert.type === 'contract_address') return true;
  if (alert.type === 'highlighted_user') return alert.message?.hasContractAddress === true;
  return false;
}

/**
 * Which subscribable class an alert belongs to, or null when it is not one.
 *
 * The shape mirrors bot/alerts.ts's triggerForAlert on purpose: the two bots
 * should never disagree about what an alert IS, only about who gets it.
 */
export function classifyAlert(alert: AlertLike): TgAlertType | null {
  if (isContractDetection(alert)) return 'contract';
  switch (alert.type) {
    case 'highlighted_user':
      return 'highlighted';
    case 'keyword_match':
      return 'keyword';
    case 'missed_runner':
      return 'missedRunner';
    // 'mcapCross' is deliberately absent: it never travels as an AlertLike.
    // See the note at the top of this file.
    default:
      // Anything that does not reach onAlert, and anything added later that
      // nobody has decided a volume for yet. Silence is the safe answer.
      return null;
  }
}

/**
 * Per-chat alert preferences.
 *
 * Stored as JSONB on tg_bot_chats so a new toggle is a code change rather than
 * a migration. Read through `readSettings`, which supplies the default for
 * every absent key — that is what stops a deploy from switching something on in
 * a live chat.
 */
export interface TgChatSettings {
  /** Delivery mode per class. Absent or unrecognised reads as 'off'. */
  alerts: Record<TgAlertType, TgAlertDelivery>;
  /** Epoch ms until which the circuit breaker has muted this chat; 0 = live. */
  mutedUntil: number;
  /** Why it was muted, echoed by /status. Null when it never has been. */
  mutedReason: string | null;
}

/**
 * The state a brand-new chat is in, and the default every ABSENT key reads as
 * (see readSettings). Every incident class is OFF — the fail-closed guarantee
 * that stopped the flood.
 *
 * `octSignals` is the ONE deliberate exception: it is ON (instant) by default,
 * on the operator's explicit instruction, because it is a curated,
 * operator-controlled stream rather than the raw feed. It defaults on for
 * EXISTING chats too — their stored blobs predate the key, so readSettings
 * supplies this value — which is how every current subscriber starts receiving
 * it without a migration. It stays a normal toggle: `/alerts off signals`
 * silences it, and turning it off round-trips like any other class. The hourly
 * ceiling still binds it, and it cannot trip the circuit breaker (alerts.ts), so
 * a default-on bursty class cannot mute a chat's other subscriptions.
 */
export const DEFAULT_CHAT_SETTINGS: TgChatSettings = {
  alerts: {
    octSignals: 'instant',
    missedRunner: 'off',
    mcapCross: 'off',
    keyword: 'off',
    highlighted: 'off',
    contract: 'off',
  },
  mutedUntil: 0,
  mutedReason: null,
};

function isDelivery(value: unknown): value is TgAlertDelivery {
  return value === 'off' || value === 'digest' || value === 'instant';
}

/**
 * Narrow an unknown JSONB blob to settings, defaulting every absent key.
 *
 * THE LEGACY KEY IS DROPPED ON PURPOSE. Rows written by the first release carry
 * `{ contractAlerts: true }`, which is exactly the subscription that flooded a
 * real group. It is not migrated to `contract: 'digest'` — it is ignored, so
 * every chat registered under the old build comes back subscribed to nothing
 * and has to opt in like a new one. That is the whole point of the fix, and it
 * is why this needs no migration: the column already holds JSONB, and the new
 * shape simply does not read the old key.
 */
export function readSettings(raw: unknown): TgChatSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawAlerts = (obj.alerts ?? {}) as Record<string, unknown>;

  const alerts = { ...DEFAULT_CHAT_SETTINGS.alerts };
  for (const type of ALERT_TYPES) {
    const value = rawAlerts[type];
    if (isDelivery(value)) alerts[type] = value;
  }

  // A stored 'instant' on a class that no longer permits it is demoted rather
  // than honoured: instantAllowed is a safety property of the class, and a
  // stored preference must never outrank a tightened one.
  for (const type of ALERT_TYPES) {
    if (alerts[type] === 'instant' && !ALERT_CATALOG[type].instantAllowed) alerts[type] = 'digest';
  }

  const mutedUntil =
    typeof obj.mutedUntil === 'number' && Number.isFinite(obj.mutedUntil) && obj.mutedUntil > 0
      ? obj.mutedUntil
      : 0;

  return {
    alerts,
    mutedUntil,
    mutedReason: typeof obj.mutedReason === 'string' ? obj.mutedReason : null,
  };
}

/** Is this chat currently muted by the circuit breaker? */
export function isMuted(settings: TgChatSettings, now: number): boolean {
  return settings.mutedUntil > now;
}

/** The classes this chat is subscribed to, in catalog order. */
export function subscribedTypes(settings: TgChatSettings): TgAlertType[] {
  return ALERT_TYPES.filter((t) => settings.alerts[t] !== 'off');
}

// --- /alerts command parsing -------------------------------------------------

/** What `/alerts …` asked for. `usage` carries the reason it did not parse. */
export type AlertsAction =
  | { kind: 'show' }
  | { kind: 'unmute' }
  | { kind: 'set'; spec: TgAlertTypeSpec; delivery: TgAlertDelivery; confirmed: boolean }
  | { kind: 'usage'; problem: string | null };

const MOD_INSTANT = new Set(['now', 'instant', 'immediate', 'immediately']);
const MOD_CONFIRM = new Set(['confirm', 'confirmed', 'yes']);

/**
 * Parse the argument tail of `/alerts`.
 *
 * Grammar, deliberately tiny:
 *   /alerts                        → show
 *   /alerts on <class> [now] [confirm]
 *   /alerts off <class>
 *   /alerts unmute
 *
 * The modifiers are scanned rather than positional, so `on contracts confirm
 * now` and `on contracts now confirm` both work. Anything else returns `usage`
 * with the specific problem — a group chat gets one clear correction, not a
 * generic "unknown command".
 */
export function parseAlertsCommand(args: string[]): AlertsAction {
  const words = args.map((a) => a.trim().toLowerCase()).filter((a) => a !== '');
  if (words.length === 0) return { kind: 'show' };

  const verb = words[0];
  if (verb === 'show' || verb === 'status' || verb === 'list') return { kind: 'show' };
  if (verb === 'unmute' || verb === 'resume') return { kind: 'unmute' };

  if (verb !== 'on' && verb !== 'off') {
    return { kind: 'usage', problem: `I do not know what "${verb}" means.` };
  }

  const target = words[1];
  if (target === undefined) {
    return { kind: 'usage', problem: `"${verb}" needs an alert type.` };
  }

  const spec = findAlertType(target);
  if (!spec) return { kind: 'usage', problem: `"${target}" is not an alert type.` };

  if (verb === 'off') return { kind: 'set', spec, delivery: 'off', confirmed: true };

  const modifiers = words.slice(2);
  const wantsInstant = modifiers.some((m) => MOD_INSTANT.has(m));
  const confirmed = modifiers.some((m) => MOD_CONFIRM.has(m));

  // Asking for instant on a class that does not allow it is refused outright
  // rather than quietly downgraded — a chat that asked for every event and got
  // a digest would reasonably think the bot was broken.
  if (wantsInstant && !spec.instantAllowed) {
    return {
      kind: 'usage',
      problem: `${spec.label} cannot be delivered per-event — ${spec.volumeNote.toLowerCase()}`,
    };
  }

  return { kind: 'set', spec, delivery: wantsInstant ? 'instant' : 'digest', confirmed };
}

// --- /mute command parsing ---------------------------------------------------

/**
 * Bounds on a manual mute.
 *
 * A FLOOR because a mute measured in seconds is not a mute, it is a
 * misunderstanding of what the command does — the digest interval alone is ten
 * minutes. A CEILING because an indefinite mute is how a chat quietly stops
 * being a user: nobody remembers they muted OCT in March, and the bot looks
 * broken rather than silenced. Seven days is long enough for a holiday and
 * short enough that it expires while somebody still remembers setting it.
 *
 * Out-of-range values are CLAMPED, not refused, because the reply states the
 * resulting deadline rather than echoing the duration — so a clamp is visible
 * in the answer instead of being a silent substitution.
 */
export const MIN_MUTE_MS = 5 * 60_000;
export const MAX_MUTE_MS = 7 * 24 * 3_600_000;
export const DEFAULT_MUTE_MS = 3_600_000;

/** What `/mute …` asked for. */
export type MuteAction =
  | { kind: 'mute'; durationMs: number }
  | { kind: 'usage'; problem: string | null };

const MUTE_UNITS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/**
 * Parse the argument tail of `/mute`.
 *
 *   /mute            → one hour
 *   /mute 30m|2h|1d  → that long, clamped to [MIN_MUTE_MS, MAX_MUTE_MS]
 *   /mute 30         → thirty MINUTES; a bare number is the ambiguous case and
 *                      minutes is the only reading where a typo is cheap
 *
 * Pure, so the handler is this call plus one store round-trip. Anything else
 * returns `usage` with the specific problem rather than a generic complaint —
 * a group gets one correction, not a guessing game.
 */
export function parseMuteCommand(args: string[]): MuteAction {
  const words = args.map((a) => a.trim().toLowerCase()).filter((a) => a !== '');
  if (words.length === 0) return { kind: 'mute', durationMs: DEFAULT_MUTE_MS };
  if (words.length > 1) return { kind: 'usage', problem: '/mute takes one duration, or none.' };

  const raw = words[0] as string;
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(raw);
  if (!match) return { kind: 'usage', problem: `"${raw}" is not a duration.` };

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { kind: 'usage', problem: `"${raw}" is not a duration.` };
  }

  const unitWord = match[2] ?? '';
  const unitMs = unitWord === '' ? 60_000 : MUTE_UNITS[unitWord];
  if (unitMs === undefined) {
    return { kind: 'usage', problem: `I do not know the unit "${unitWord}".` };
  }

  const durationMs = Math.min(Math.max(Math.round(amount * unitMs), MIN_MUTE_MS), MAX_MUTE_MS);
  return { kind: 'mute', durationMs };
}

/**
 * Apply a parsed `set` to a settings blob, returning a NEW one.
 *
 * Pure so the command handler is a store read, this call, and a store write —
 * the round-trip a test can pin without touching Supabase.
 */
export function applyAlertSetting(
  settings: TgChatSettings,
  type: TgAlertType,
  delivery: TgAlertDelivery,
): TgChatSettings {
  return { ...settings, alerts: { ...settings.alerts, [type]: delivery } };
}

/** Clear a circuit-breaker mute. The `/alerts unmute` half of the round-trip. */
export function clearMute(settings: TgChatSettings): TgChatSettings {
  return { ...settings, mutedUntil: 0, mutedReason: null };
}

/** Record a circuit-breaker mute. Written by the fan-out when the guard trips. */
export function applyMute(
  settings: TgChatSettings,
  untilMs: number,
  reason: string,
): TgChatSettings {
  return { ...settings, mutedUntil: untilMs, mutedReason: reason };
}
