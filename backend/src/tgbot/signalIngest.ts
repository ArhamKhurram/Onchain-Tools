// Hosted-mode OCT Alerts ingest: the always-on MTProto USER session that reads
// the algorithm forum-topics so signals forward even when no console session is
// open.
//
// WHY THIS EXISTS. In hosted mode every per-user gateway is connect-on-demand —
// nothing runs server-side until a browser session drives it. That is right for
// a user's own Discord/Telegram, but the OCT Alerts source is infrastructure:
// one operator OCT account, logged into the supergroup that carries the SOL/EVM
// algorithm topics, whose incoming messages `wireTelegramEvents` turns into
// forwarded cards. If that session only comes up while a console is open, a
// scan posted after a deploy (or overnight) is never ingested and nothing
// forwards. So one designated session is connected at boot and kept alive.
//
// PURE / TESTABLE. This module makes NO I/O of its own: it resolves the ingest
// user id from env, decides (given a config already read by the caller) whether
// to connect, and holds the keep-alive registry. The actual `connectTelegram`
// and the single boot-time `getConfig` read live in the composition root
// (index.ts), so the decision logic is a unit test rather than a running bot.

/**
 * Env names for the OCT account whose Telegram session ingests the algorithm
 * topics, primary first.
 *
 * `OCT_SIGNAL_INGEST_USER_ID` lets an operator point ingest at a DIFFERENT
 * account than the one whose alert stream the bot fans out. When it is unset we
 * fall back to `TG_BOT_ALERT_SOURCE_USER_ID` (the account that already drives
 * the bot's feed — see tgbot/source.ts), because in the normal single-operator
 * deployment that IS the account subscribed to the topics.
 */
const INGEST_USER_ID_ENV = [
  'OCT_SIGNAL_INGEST_USER_ID',
  'TG_BOT_ALERT_SOURCE_USER_ID',
  'OCT_TG_BOT_ALERT_SOURCE_USER_ID',
] as const;

/** The configured ingest OCT user id, or null when none is set. */
export function resolveSignalIngestUserId(): string | null {
  for (const name of INGEST_USER_ID_ENV) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** The Telegram-credential slice of a user's config the ingest connect needs. */
export interface SignalIngestConfig {
  telegramSessions?: string[] | null;
  telegramApiId?: string | null;
  telegramApiHash?: string | null;
}

/**
 * What boot (and the watchdog) should do for the ingest user.
 *
 *   • `skip`            — no ingest user configured; feature off, not an error.
 *   • `missing-session` — a user is named but has no usable Telegram session /
 *                         apiId / apiHash stored. Logged as a clear one-line
 *                         reason; the watchdog keeps checking so a session
 *                         configured later is picked up without a restart.
 *   • `connect`         — connect this session and keep it alive.
 *
 * `apiId`/`apiHash`/`sessions` ride the plan so the caller never re-reads them,
 * but the caller MUST NOT log them.
 */
export type SignalIngestPlan =
  | { action: 'skip' }
  | { action: 'missing-session'; userId: string }
  | { action: 'connect'; userId: string; apiId: number; apiHash: string; sessions: string[] };

export function planSignalIngest(
  userId: string | null,
  config: SignalIngestConfig | null,
): SignalIngestPlan {
  if (!userId) return { action: 'skip' };

  const sessions = (config?.telegramSessions ?? []).filter(
    (s): s is string => typeof s === 'string' && s.trim() !== '',
  );
  const apiIdRaw = config?.telegramApiId?.trim();
  const apiHash = config?.telegramApiHash?.trim();
  const apiId = apiIdRaw ? Number(apiIdRaw) : Number.NaN;

  if (sessions.length === 0 || !apiIdRaw || !apiHash || !Number.isInteger(apiId) || apiId <= 0) {
    return { action: 'missing-session', userId };
  }
  return { action: 'connect', userId, apiId, apiHash, sessions };
}

/**
 * The set of user ids whose Telegram session is infrastructure, not on-demand.
 *
 * These sessions are EXEMPT from teardown by the on-demand lifecycle: nothing
 * idle-evicts them (unlike the Discord `UserGatewayPool`), and the ingest
 * watchdog re-establishes any that go missing. Transient socket drops are
 * healed by the client wrapper's own reconnect; this registry guards against a
 * session being gone entirely (never connected, or explicitly disconnected).
 */
const keepAlive = new Set<string>();

export const signalIngestKeepAlive = {
  mark(userId: string): void {
    keepAlive.add(userId);
  },
  has(userId: string): boolean {
    return keepAlive.has(userId);
  },
  list(): string[] {
    return [...keepAlive];
  },
  /** Test-only: reset the registry between cases. */
  reset(): void {
    keepAlive.clear();
  },
};

/** A user id trimmed to a log-safe prefix (never the full Supabase id). */
export function redactUserId(userId: string): string {
  return `${userId.slice(0, 8)}…`;
}
