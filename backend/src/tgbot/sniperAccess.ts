// Who may see, and who may change, sniper settings from Telegram.
//
// THE SNIPER IS THE ONE SUBSYSTEM THAT SPENDS MONEY (CLAUDE.md). Nothing here
// spends anything — `executeFire` remains the only function that can, and this
// file adds no path to it — but the tip and priority fee ARE what the operator
// bids for blockspace, so a stranger who could set them could make every fire
// cost more. That is enough to warrant its own gate rather than reusing the
// alert-subscription one.
//
// FOUR CONDITIONS, ALL REQUIRED, EVALUATED IN THIS ORDER:
//
//   1. PRIVATE CHAT ONLY. Not "admins of a group" — a group at all. A group
//      admin is somebody trusted to decide what a ROOM receives; that is a
//      different authority from spending the operator's SOL, and Telegram
//      cannot tell the two apart. `decideChatWrite` would happily allow a group
//      admin here, which is exactly why this check sits in FRONT of it rather
//      than being folded into it: this is not a stricter version of the chat
//      write rule, it is a different question asked first.
//
//   2. THE CHAT-WRITE RULE, unchanged (permissions.ts). In a private chat that
//      means the sender is the chat's own owner, which closes the forged-sender
//      case. One rule, called — never reimplemented.
//
//   3. AN OPERATOR ALLOWLIST, by TELEGRAM user id, in env
//      (`TG_BOT_SNIPER_OPERATORS`). UNSET MEANS NOBODY: the whole surface is
//      dark until the operator names themselves, so shipping this cannot widen
//      anything on a deployment that has not opted in. Env rather than a table
//      for the same three reasons access.ts gives: it is an operator decision,
//      it must hold before any storage is reachable, and a bad database row
//      must never be able to widen it.
//
//   4. A RESOLVED OCT USER (source.ts). Even a named operator needs an account
//      whose settings are being read; with nothing resolved there is no answer
//      to "whose fees?" and inventing one would be the fail-open mistake.
//
// WHY THE ALLOWLIST IS BY TELEGRAM USER AND NOT BY CHAT. `TG_BOT_ALLOWED_CHAT_IDS`
// already exists and is the right shape for "which rooms does this bot serve".
// It is the wrong shape here: it is optional (unset serves everyone), and a
// chat id is a place rather than a person. Spending authority belongs to a
// person, so this names people, and it fails closed when it names none.

import { decideChatWrite, type ChatActor } from './permissions.js';
import { resolveAlertSource, readDefaultAlertSource, type SourcedChat } from './source.js';

const ENV_NAMES = ['TG_BOT_SNIPER_OPERATORS', 'OCT_TG_BOT_SNIPER_OPERATORS'] as const;

/**
 * Parse a comma-separated Telegram user-id allowlist.
 *
 * Returns null for absent/blank/unusable — "nobody", which here is the SAFE
 * value and therefore also the value a half-cleared variable lands on. Note the
 * deliberate difference from `parseAllowedChatIds`, where null means "everyone":
 * that gate defaults open because a chat allowlist is a convenience; this one
 * defaults closed because it guards the money path.
 *
 * A Telegram USER id is always positive (a negative id is a chat), so a leading
 * `-` is rejected rather than parsed — pasting a group id in here should fail
 * loudly, not authorize something surprising.
 */
export function parseSniperOperators(raw: string | undefined): Set<number> | null {
  if (raw === undefined) return null;
  const ids = new Set<number>();

  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    if (!/^\d+$/.test(token)) {
      console.warn(
        `[TgBot] Ignoring non-numeric sniper operator id: ${JSON.stringify(token)} ` +
          '(a Telegram user id is a positive integer).',
      );
      continue;
    }
    const id = Number(token);
    if (!Number.isSafeInteger(id) || id <= 0) {
      console.warn(`[TgBot] Ignoring out-of-range sniper operator id: ${token}`);
      continue;
    }
    ids.add(id);
  }

  return ids.size > 0 ? ids : null;
}

/** The configured operators, or null when none. Read fresh so tests can vary it. */
export function readSniperOperators(): Set<number> | null {
  for (const name of ENV_NAMES) {
    const parsed = parseSniperOperators(process.env[name]);
    if (parsed) return parsed;
  }
  return null;
}

export type SniperAccessVerdict =
  | { allow: true; userId: string }
  | {
      allow: false;
      reason: 'not_private' | 'not_owner' | 'not_operator' | 'no_account';
      message: string;
    };

export interface SniperAccessInput {
  /** The chat, for the chat-write rule and the private-only check. */
  actor: ChatActor;
  /** The chat's roster row, for its `source_user_id`. */
  chat: SourcedChat;
  /** The operator allowlist. Null = nobody. */
  operators: Set<number> | null;
  /** The instance default alert source; injected so the rule stays pure. */
  fallbackUserId: string | null;
}

/**
 * May this actor use the sniper surface in this chat, and as which OCT user?
 *
 * Pure: no clock, no I/O, no module state. The caller gathers the facts (the
 * roster row, the admin verdict, the env) so this can be unit-tested against
 * every refusal without a Telegram API or a database.
 *
 * The refusal messages say WHICH condition failed but never who would pass —
 * a stranger probing the bot should learn that the surface exists and that they
 * are not on it, and nothing else.
 */
export function decideSniperAccess(input: SniperAccessInput): SniperAccessVerdict {
  const { actor, chat, operators, fallbackUserId } = input;

  // 1. Private only. FIRST, so no group ever reaches the operator check — a
  //    group admin who happens to be an operator still cannot run this in the
  //    group, because the reply itself would put account settings in a room.
  if (actor.chatType !== 'private') {
    return {
      allow: false,
      reason: 'not_private',
      message:
        'Sniper settings are private-chat only. Message the bot directly — a group is not the ' +
        'place to read or change what the account bids for blockspace.',
    };
  }

  // 2. The one chat-write rule, called rather than restated.
  const write = decideChatWrite(actor);
  if (!write.allow) {
    return { allow: false, reason: 'not_owner', message: write.message };
  }

  // 3. The operator allowlist. Unset = nobody, deliberately.
  if (operators === null || !operators.has(actor.userId)) {
    return {
      allow: false,
      reason: 'not_operator',
      message: 'You are not authorized to use OCT sniper settings.',
    };
  }

  // 4. An account to act on.
  const userId = resolveAlertSource(chat, fallbackUserId);
  if (userId === null) {
    return {
      allow: false,
      reason: 'no_account',
      message:
        'This chat is not linked to an OCT account, so there are no sniper settings to show. ' +
        'Set TG_BOT_ALERT_SOURCE_USER_ID, or link the chat, and try again.',
    };
  }

  return { allow: true, userId };
}

/** The env-reading wrapper. Kept thin so the rule above stays pure. */
export function decideSniperAccessFromEnv(
  actor: ChatActor,
  chat: SourcedChat,
): SniperAccessVerdict {
  return decideSniperAccess({
    actor,
    chat,
    operators: readSniperOperators(),
    fallbackUserId: readDefaultAlertSource(),
  });
}
