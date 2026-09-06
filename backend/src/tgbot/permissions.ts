// Who may change what a chat receives. One rule, two surfaces.
//
// THE HOLE THIS CLOSES. The /start panel authorizes every press
// (panel.ts's decidePanelPress): in a group, only a creator or administrator
// may retune the alert subscriptions or lift a circuit-breaker mute, because
// the panel is a shared message any member can tap. The TYPED commands had no
// such check — `/alerts on contracts confirm` from any member of any group
// subscribed the whole room to OCT's loudest event class, which is precisely
// the outcome the panel's rule exists to prevent. A permission model with a
// button half and no command half is not a permission model; it is a speed bump.
//
// SO THE RULE LIVES HERE AND BOTH SURFACES CALL IT. decidePanelPress delegates
// its write case to `decideChatWrite`, and every command that writes calls the
// same function. There is exactly one place to read, and one place to get it
// wrong.
//
// FAIL-CLOSED ON AN UNANSWERABLE QUESTION. `isAdmin` is resolved by
// getChatMember, and a failed call — a rate limit, a transport blip, a chat the
// bot was just removed from — resolves FALSE at the call site, never
// "probably". "We could not check" and "not permitted" must have the same
// consequence for a control that changes what a whole room receives.
//
// Pure: no clock, no I/O, no module state. The caller gathers the two facts.

import type { TgChat } from './types.js';

/** Everything the rule is allowed to know about who is acting. */
export interface ChatActor {
  /** The chat being changed. */
  chatId: number;
  chatType: TgChat['type'];
  /** The ACTING user — the presser of a button, the sender of a command. */
  userId: number;
  /** Creator or administrator here? False whenever the question could not be answered. */
  isAdmin: boolean;
}

export type WriteVerdict =
  | { allow: true }
  | { allow: false; reason: 'not_owner' | 'not_admin'; message: string };

/**
 * May this user change this chat's settings?
 *
 *   • PRIVATE chat — the chat id IS the user id, so anyone else acting is
 *     impossible through a Telegram client and therefore forged. One line to
 *     reject it.
 *   • GROUP or SUPERGROUP — creator or administrator only. Never treat 'group'
 *     and 'supergroup' differently: Telegram upgrades one to the other without
 *     warning (see TgChat).
 *   • CHANNEL — a channel post has no interactive sender to authorize, and
 *     router.ts already drops those. Falling through to the admin check is the
 *     safe end of that: an unresolvable admin status is a refusal.
 *
 * The refusal messages are the panel's, verbatim, because a person who is
 * refused a button and then refused the equivalent command should read the same
 * sentence rather than wonder whether the two mean different things.
 */
export function decideChatWrite(actor: ChatActor): WriteVerdict {
  if (actor.chatType === 'private') {
    if (actor.userId !== actor.chatId) {
      return { allow: false, reason: 'not_owner', message: 'This panel is not yours.' };
    }
    return { allow: true };
  }

  if (!actor.isAdmin) {
    return {
      allow: false,
      reason: 'not_admin',
      message: 'Only a group admin can change what this chat receives.',
    };
  }

  return { allow: true };
}
