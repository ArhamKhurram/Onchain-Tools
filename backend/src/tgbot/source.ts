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

/**
 * The only field of a chat record this module reads.
 *
 * Narrower than `TgChatRecord` on purpose: it keeps the resolution rule
 * testable without a whole roster row, and it means nothing here can start
 * depending on a chat's settings or entitlements by accident.
 */
export interface SourcedChat {
  /** Whose OCT alerts this chat receives; null = the instance default. */
  sourceUserId: string | null;
}

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
 * Should a chat that resolves only via the instance default be filtered by that
 * account's console thresholds? Off unless the operator asks for it — see
 * `chatsPassingSignalFilters` for why the default is the conservative one.
 */
export function readDefaultSourceFiltersEnabled(): boolean {
  const raw = process.env.TG_BOT_DEFAULT_SOURCE_FILTERS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * The OCT user id whose alerts this chat receives, or null for "none".
 *
 * Pure apart from the env/mode read, and exported so the fan-out and /status
 * can never disagree about which chats are actually wired up.
 */
export function resolveAlertSource(record: SourcedChat, fallback: string | null): string | null {
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

// --- Per-user signal filters -------------------------------------------------

/**
 * The question a poller-raised signal asks about one OCT user.
 *
 * Structurally identical to `mcapCross/poller.ts`'s `McapCrossDeliveryVerdict`
 * and deliberately NOT imported from it: `mcapCross/` is injected into rather
 * than importing `tgbot/`, and duplicating four lines of shape is cheaper than
 * reversing that. index.ts, the composition root, satisfies both.
 */
export interface SignalFilterGate {
  /** What a chat that resolves to NO user gets — the operator/env baseline. */
  baselinePass: boolean;
  /** Would this user's own thresholds pass it? Never true for an abstain. */
  passesFor(userId: string): Promise<boolean>;
}

/**
 * Narrow a subscribed-chat list to the chats whose OWNER wants this signal.
 *
 * WHY THIS IS THE WHOLE ANSWER TO "the roster is chats, not users". It is —
 * and every chat row still carries `source_user_id`, the column whose entire
 * documented purpose is naming whose alerts the chat receives. So the mapping
 * already exists; this just uses it. Three cases, and only the third is new:
 *
 *   • an explicit `source_user_id`  → that user's filters decide
 *   • the instance default (env, or 'local' in local mode) → `baselinePass`,
 *     unless the operator opts in (see below)
 *   • nothing resolves              → `baselinePass`, i.e. byte-for-byte what
 *     the chat received before this function existed
 *
 * The last two cases are load-bearing. A chat nobody has linked must keep
 * getting exactly the operator baseline; starting to drop its alerts because
 * "no filters resolved" would be a silent regression, strictly worse than a
 * missing feature.
 *
 * WHY THE INSTANCE DEFAULT DOES NOT FILTER BY DEFAULT. It is tempting to let it
 * — that account IS the one driving the chat's feed. But the two settings mean
 * different things: `TG_BOT_ALERT_SOURCE_USER_ID` names WHOSE STREAM the chats
 * follow, while the console filters are a personal reading preference. Letting
 * the second silently govern the first means an operator tightening their own
 * console quietly mutes every group chat on the instance, with no indication in
 * either place that the two are connected. Linking a chat is an explicit act
 * and personalising it is a fair consequence; inheriting a stranger's
 * thresholds because of an env var is not. `TG_BOT_DEFAULT_SOURCE_FILTERS=1`
 * turns it on for an operator who does want their console to drive every chat.
 *
 * ONE READ PER USER, NOT PER CHAT. Twenty chats sharing one instance default
 * ask `passesFor` once. The gate caches on its own side too; this memo only
 * guarantees the fan-out cannot be the thing that multiplies it.
 */
export async function chatsPassingSignalFilters<T extends SourcedChat>(
  chats: readonly T[],
  fallback: string | null,
  gate: SignalFilterGate,
): Promise<T[]> {
  const memo = new Map<string, Promise<boolean>>();
  const out: T[] = [];
  const defaultFilters = readDefaultSourceFiltersEnabled();

  for (const chat of chats) {
    // Only an EXPLICITLY linked chat is personalised unless the operator opts
    // in; a chat riding the instance default keeps the baseline.
    const source = chat.sourceUserId ?? (defaultFilters ? fallback : null);
    if (source === null) {
      if (gate.baselinePass) out.push(chat);
      continue;
    }
    let pending = memo.get(source);
    if (!pending) {
      pending = gate.passesFor(source);
      memo.set(source, pending);
    }
    if (await pending) out.push(chat);
  }

  return out;
}
