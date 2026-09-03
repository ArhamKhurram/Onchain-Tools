// Whose alerts a Telegram chat receives.
//
// THE PROBLEM THIS SOLVES. OCT alerts are per-OCT-user: WsServer.broadcastAlert
// carries a userId, and in hosted mode two users watching two different sets of
// rooms produce two different alert streams. A Telegram group is not an OCT
// user — that is the entire point of the bot — so "which stream does this group
// get?" has no answer unless one is configured.
//
// Answering it wrongly in the permissive direction would fan one user's private
// feed out to a group they are not in. So this resolves in a fixed order and
// fails CLOSED:
//
//   1. the chat row's source_user_id  — the seam for a future linking flow;
//      nothing writes it yet
//   2. TG_BOT_ALERT_SOURCE_USER_ID    — the operator naming one OCT account
//      whose feed drives every chat on this instance
//   3. local mode only: 'local'       — the desktop app has exactly one user,
//      so there is nothing to disambiguate
//
// Nothing resolved means the chat gets commands and no alerts, and /status says
// so out loud rather than looking healthy while delivering nothing.

import { isHostedMode } from '../storage/index.js';
import type { TgChatRecord } from './chatStore.js';

/** The implicit single user of local mode. Declared per module across the backend. */
const LOCAL_USER_ID = 'local';

const ENV_NAMES = ['TG_BOT_ALERT_SOURCE_USER_ID', 'OCT_TG_BOT_ALERT_SOURCE_USER_ID'] as const;

/** The instance-wide default alert source, or null when none is configured. */
export function readDefaultAlertSource(): string | null {
  for (const name of ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return isHostedMode() ? null : LOCAL_USER_ID;
}

/**
 * The OCT user id whose alerts this chat receives, or null for "none".
 *
 * Pure apart from the env/mode read, and exported so the fan-out and /status
 * can never disagree about which chats are actually wired up.
 */
export function resolveAlertSource(record: TgChatRecord, fallback: string | null): string | null {
  return record.sourceUserId ?? fallback;
}

/**
 * Does an alert carrying `userId` belong to this chat?
 *
 * `broadcastAlert` omits the userId in local mode (there is one user and the
 * fan-out is unconditional), so an undefined userId matches the local source.
 */
export function alertMatchesSource(alertUserId: string | undefined, source: string | null): boolean {
  if (source === null) return false;
  return (alertUserId ?? LOCAL_USER_ID) === source;
}
