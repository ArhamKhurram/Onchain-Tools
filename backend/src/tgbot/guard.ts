// The backstop: a hard ceiling on what one chat can be sent, and a circuit
// breaker for when something upstream has clearly gone wrong.
//
// NOT THE SAME THING AS sender.ts's LIMITER. That one exists to keep Telegram
// happy — ~20 messages per minute into a group, enforced with 429s, and
// exceeding it gets the bot throttled for hours. This one exists to keep the
// PERSON happy, and its budget is an order of magnitude tighter: ten messages
// an hour, because a chat app pings. Passing Telegram's limiter tells you the
// API will accept the message; passing this one tells you a human should
// receive it.
//
// WHY BOTH A CEILING AND A BREAKER, counting different things:
//
//   The CEILING meters messages we actually send, and drops the overflow. It
//   is the guarantee — whatever policy above it decides, and whatever the feed
//   does, a chat cannot receive more than maxPerHour. Dropping is deliberate:
//   holding the overflow just delivers a stale alert later while the queue
//   grows, which is the failure mode sender.ts already rejected.
//
//   The BREAKER meters EVENTS ROUTED to the chat — including the ones the
//   ceiling then drops. That distinction is the whole point. If the breaker
//   counted deliveries it could never fire, because the ceiling would have
//   already clamped the rate to something that looks healthy. Counting
//   attempts is what makes a mis-specification visible: the incident that
//   prompted this file would have produced hundreds of attempts a minute into
//   one chat while the ceiling reported a tidy ten an hour.
//
// Pure and clock-injected throughout: no timers, no logging, no I/O. The
// fan-out logs, and persists the mute the breaker asks for. That keeps the
// window arithmetic unit-testable without waiting out a real hour.

/** Messages per chat per hour, before the overflow is dropped. */
const DEFAULT_MAX_PER_HOUR = 10;
const CEILING_WINDOW_MS = 3_600_000;

/** Events routed to one chat inside BREAKER_WINDOW_MS before it auto-mutes. */
const DEFAULT_BREAKER_MAX_EVENTS = 30;
const DEFAULT_BREAKER_WINDOW_MS = 60_000;

/** How long an auto-mute lasts. Long enough that a bad deploy cannot outlast it. */
const DEFAULT_BREAKER_MUTE_MS = 6 * 3_600_000;

export interface GuardLimits {
  maxPerHour: number;
  ceilingWindowMs: number;
  breakerMaxEvents: number;
  breakerWindowMs: number;
  breakerMuteMs: number;
}

export const DEFAULT_GUARD_LIMITS: GuardLimits = {
  maxPerHour: DEFAULT_MAX_PER_HOUR,
  ceilingWindowMs: CEILING_WINDOW_MS,
  breakerMaxEvents: DEFAULT_BREAKER_MAX_EVENTS,
  breakerWindowMs: DEFAULT_BREAKER_WINDOW_MS,
  breakerMuteMs: DEFAULT_BREAKER_MUTE_MS,
};

/**
 * Read one positive-integer env var, with the OCT_-prefixed alias every var in
 * this directory carries (see access.ts, source.ts). A missing, blank,
 * non-numeric or non-positive value falls back to the default rather than
 * disabling the limit — a typo must not be able to turn the ceiling off.
 */
function readPositiveInt(name: string, fallback: number): number {
  for (const key of [name, `OCT_${name}`]) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0) return value;
    console.warn(`[TgBot] Ignoring invalid ${key}=${JSON.stringify(raw)}; using ${fallback}.`);
  }
  return fallback;
}

/** The configured limits. Read fresh so tests and a restart-free env change apply. */
export function readGuardLimits(): GuardLimits {
  return {
    maxPerHour: readPositiveInt('TG_BOT_MAX_MESSAGES_PER_HOUR', DEFAULT_MAX_PER_HOUR),
    ceilingWindowMs: CEILING_WINDOW_MS,
    breakerMaxEvents: readPositiveInt('TG_BOT_BREAKER_MAX_EVENTS', DEFAULT_BREAKER_MAX_EVENTS),
    breakerWindowMs: readPositiveInt('TG_BOT_BREAKER_WINDOW_MS', DEFAULT_BREAKER_WINDOW_MS),
    breakerMuteMs: readPositiveInt('TG_BOT_BREAKER_MUTE_MS', DEFAULT_BREAKER_MUTE_MS),
  };
}

/** Why a send was refused. 'ok' is the only value that permits one. */
export type SendVerdict = 'ok' | 'muted' | 'ceiling';

export interface SendDecision {
  allow: boolean;
  reason: SendVerdict;
  /** Messages already counted against this chat's hour, after this call. */
  used: number;
  limit: number;
}

export interface EventDecision {
  /** True on the single call that trips the breaker; false on every other. */
  tripped: boolean;
  /** Epoch ms the caller should mute the chat until. Only set when tripped. */
  muteUntil: number;
  /** Events counted in the breaker window, including this one. */
  events: number;
}

/** A sliding window of timestamps per chat. */
class Windows {
  private hits = new Map<number, number[]>();

  constructor(private readonly windowMs: number) {}

  /** Record one hit and return the window's size including it. */
  push(chatId: number, now: number): number {
    const kept = this.recent(chatId, now);
    kept.push(now);
    this.hits.set(chatId, kept);
    return kept.length;
  }

  /** The window's current size, without recording anything. */
  count(chatId: number, now: number): number {
    return this.recent(chatId, now).length;
  }

  /** Forget one chat's window, leaving every other chat's untouched. */
  clear(chatId: number): void {
    this.hits.delete(chatId);
  }

  prune(now: number): void {
    for (const chatId of [...this.hits.keys()]) {
      const kept = this.recent(chatId, now);
      if (kept.length === 0) this.hits.delete(chatId);
      else this.hits.set(chatId, kept);
    }
  }

  private recent(chatId: number, now: number): number[] {
    const cutoff = now - this.windowMs;
    return (this.hits.get(chatId) ?? []).filter((t) => t > cutoff);
  }
}

export class ChatOutboundGuard {
  private readonly sends: Windows;
  private readonly events: Windows;

  constructor(private readonly limits: GuardLimits = DEFAULT_GUARD_LIMITS) {
    this.sends = new Windows(limits.ceilingWindowMs);
    this.events = new Windows(limits.breakerWindowMs);
  }

  /**
   * Count one event routed to this chat and report whether that tripped the
   * breaker.
   *
   * Called once per event per recipient chat, BEFORE any decision about how it
   * will be delivered — a digest entry counts exactly as much as an instant
   * send, because the thing being detected is upstream volume, not our own.
   *
   * `tripped` is true on exactly one call: the window is cleared when it fires,
   * so a chat that keeps receiving events does not re-trip on every one of them
   * and re-mute in a loop. It will trip again a full window later if the flood
   * is still going, which is the right cadence for a log line.
   */
  noteEvent(chatId: number, now: number): EventDecision {
    const events = this.events.push(chatId, now);
    if (events < this.limits.breakerMaxEvents) {
      return { tripped: false, muteUntil: 0, events };
    }
    // This chat's window only — another chat's progress towards its own
    // breaker is unrelated and must survive.
    this.events.clear(chatId);
    return { tripped: true, muteUntil: now + this.limits.breakerMuteMs, events };
  }

  /**
   * May we send one message to this chat right now?
   *
   * `mutedUntil` is passed in rather than held here: the mute is persisted in
   * the chat's settings row, so it survives a restart and is what /status
   * reports. Keeping it out of this class means there is one source of truth
   * for "is this chat muted", and this class stays pure.
   *
   * Consumes a slot only when it allows the send.
   */
  admitSend(chatId: number, now: number, mutedUntil: number): SendDecision {
    const limit = this.limits.maxPerHour;

    if (mutedUntil > now) {
      return { allow: false, reason: 'muted', used: this.sends.count(chatId, now), limit };
    }

    const used = this.sends.count(chatId, now);
    if (used >= limit) return { allow: false, reason: 'ceiling', used, limit };

    return { allow: true, reason: 'ok', used: this.sends.push(chatId, now), limit };
  }

  /** Messages counted against this chat's hour. For /status, which sends nothing. */
  usedThisHour(chatId: number, now: number): number {
    return this.sends.count(chatId, now);
  }

  /** Forget chats with no recent activity, so neither map grows forever. */
  prune(now: number): void {
    this.sends.prune(now);
    this.events.prune(now);
  }
}
