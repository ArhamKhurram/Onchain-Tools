// `/link <code>` and `/unlink` — binding a chat to an OCT account.
//
// This is the redeeming half of the flow whose minting half is
// `POST /api/tgbot/link-code`; linkCodes.ts holds the rules and the argument
// for why they are the rules. What this file adds is the SECOND proof.
//
// TWO PROOFS, AND NEITHER IS OPTIONAL.
//
//   1. Proof of the ACCOUNT is the code. It can only have come from an
//      authenticated console session, it is single-use, it expires in minutes,
//      and only its hash is stored. There is no other way to name an account
//      here: `/link` takes a code and nothing else — no email, no user id, no
//      handle — so there is no input that binds a chat to an account the sender
//      cannot already sign in to.
//
//   2. Proof of the CHAT is the message. Telegram authenticates who sent it and
//      where, and in a group `decideChatWrite` (through ctx.authorizeWrite)
//      requires a creator or administrator, with the fail-closed AdminCache
//      behind it. Binding a room is a decision about the whole room: everyone
//      in it will read that account's alerts, and its admins can retune that
//      account's thresholds.
//
// WHY REGISTRATION IS REQUIRED FIRST. `/link` in an unregistered chat is
// refused rather than quietly registering it, for the same reason `/alerts` and
// `/mute` are: a chat becomes a tenant by /start, deliberately, and creating one
// as a side effect of a credential redemption is the fail-open mistake in a new
// place. The code is NOT spent in that case — the refusal happens first.
//
// THE CODE IS NEVER ECHOED. Not in the reply, not in a log line, not in an
// error. It is a bearer credential for its lifetime, and a used one is still
// worth not publishing: it names the account it belonged to.

import { getChatStore } from '../chatStore.js';
import { SPEC } from '../commandCatalog.js';
import { bold, code, escapeHtml, joinLines } from '../html.js';
import { accountFingerprint } from '../identity.js';
import { getLinkCodeService, LINK_CODE_TTL_MS } from '../linkCodes.js';
import { footer } from '../render.js';
import type { TgCommand, TgCommandContext } from './types.js';

/** One sentence for every way a code can fail to be a code. See below. */
const REFUSED =
  'That code is not valid. Codes last a few minutes and work once — generate a fresh one in the OCT console.';

function usage(): string {
  return joinLines([
    bold('Link this chat to an OCT account'),
    '',
    escapeHtml('1. Open the OCT console → Settings → Telegram bot.'),
    escapeHtml('2. Generate a link code.'),
    `3. Send ${code('/link ABCD-EFGH')} here, within ${Math.round(LINK_CODE_TTL_MS / 60_000)} minutes.`,
    '',
    escapeHtml(
      'Linking sends that account’s alerts to this chat and lets this chat’s admins edit its alert filters. Nothing else about the account is exposed, and no Telegram credential is handed over.',
    ),
    '',
    escapeHtml('Undo it at any time with /unlink.'),
    footer(),
  ]);
}

async function runLink(ctx: TgCommandContext): Promise<void> {
  const raw = ctx.command.rest.trim();
  if (raw === '') {
    await ctx.reply(usage());
    return;
  }

  const store = getChatStore();
  const record = await store.get(ctx.chatId);
  if (!record) {
    await ctx.reply(
      joinLines([escapeHtml('This chat is not registered yet. Run /start first.'), footer()]),
    );
    return;
  }

  // Authority over the CHAT, before the code is spent. A group member who is
  // not an admin must not be able to burn an admin's code by racing them.
  const authorized = await ctx.authorizeWrite();
  if (!authorized.allow) {
    await ctx.reply(joinLines([escapeHtml(authorized.message), footer()]));
    return;
  }

  const result = await getLinkCodeService().redeem(raw, ctx.chatId);
  if (!result.ok) {
    // ONE MESSAGE for malformed, unknown, expired and already-used. Telling a
    // guesser which of those they hit is free information about the code space,
    // and none of the four suggests a different action to an honest user.
    // 'throttled' is the exception: it is the one the honest user can act on.
    await ctx.reply(
      joinLines([
        escapeHtml(
          result.reason === 'throttled'
            ? 'Too many link attempts in this chat. Wait a few minutes and try again.'
            : result.reason === 'unavailable'
              ? 'Linking is unavailable right now — OCT storage did not answer. Nothing has changed.'
              : REFUSED,
        ),
        footer(),
      ]),
    );
    return;
  }

  const previous = record.sourceUserId;
  const bound = await store.setSourceUser(ctx.chatId, result.userId);
  if (!bound) {
    // The code is spent and the binding did not land. Say exactly that, rather
    // than "try again" with a code that will now be refused.
    await ctx.reply(
      joinLines([
        escapeHtml(
          'Could not save the link — OCT storage is unavailable. That code has been used up; generate a new one and try again in a minute.',
        ),
        footer(),
      ]),
    );
    return;
  }

  const label = accountFingerprint(result.userId) ?? 'an OCT account';
  await ctx.reply(
    joinLines([
      `${bold('Linked.')} ${escapeHtml(`This chat now receives OCT account ${label}.`)}`,
      previous && previous !== result.userId
        ? escapeHtml(
            `It was previously linked to ${accountFingerprint(previous) ?? 'another account'}; that link has been replaced.`,
          )
        : null,
      '',
      escapeHtml(
        'Nothing is subscribed yet — open /start and turn on the alert classes you want. /filters edits this account’s market-cap thresholds.',
      ),
      ctx.chat.type === 'private'
        ? null
        : escapeHtml(
            'The code you sent is now spent and cannot be reused by anyone who read it here.',
          ),
      footer(),
    ]),
  );
}

/**
 * `/unlink` — the undo, behind one confirmation.
 *
 * A TYPED CONFIRMATION RATHER THAN A SECOND COMMAND. `/unlink` alone reports
 * what is bound and what unlinking costs; `/unlink confirm` performs it. That
 * is the same shape the panel uses (a warning card whose button carries the
 * write), so the two surfaces cannot disagree about how many deliberate acts it
 * takes.
 *
 * It restores the pre-link state exactly: `source_user_id` returns to null and
 * `resolveAlertSource` falls back to the instance default, or to nothing.
 * Subscriptions, mutes and digest settings are untouched, because they are the
 * chat's and not the account's.
 */
async function runUnlink(ctx: TgCommandContext): Promise<void> {
  const store = getChatStore();
  const record = await store.get(ctx.chatId);
  if (!record) {
    await ctx.reply(
      joinLines([escapeHtml('This chat is not registered yet. Run /start first.'), footer()]),
    );
    return;
  }

  if (!record.sourceUserId) {
    await ctx.reply(
      joinLines([
        escapeHtml('This chat is not linked to an OCT account, so there is nothing to unlink.'),
        footer(),
      ]),
    );
    return;
  }

  const authorized = await ctx.authorizeWrite();
  if (!authorized.allow) {
    await ctx.reply(joinLines([escapeHtml(authorized.message), footer()]));
    return;
  }

  const label = accountFingerprint(record.sourceUserId) ?? 'an OCT account';
  const confirmed = ctx.command.args[0]?.toLowerCase() === 'confirm';
  if (!confirmed) {
    await ctx.reply(
      joinLines([
        `${bold('Unlink this chat?')} ${escapeHtml(`It is linked to OCT account ${label}.`)}`,
        '',
        escapeHtml(
          'Unlinking stops that account’s alerts arriving here and gives up access to its filters. Subscriptions and mutes stay as they are.',
        ),
        '',
        `Run ${code('/unlink confirm')} to go ahead.`,
        footer(),
      ]),
    );
    return;
  }

  const cleared = await store.setSourceUser(ctx.chatId, null);
  await ctx.reply(
    joinLines([
      escapeHtml(
        cleared
          ? 'Unlinked. This chat is back to the instance default alert source, which for most chats is none.'
          : 'Could not unlink right now — OCT storage is unavailable. Nothing has changed.',
      ),
      footer(),
    ]),
  );
}

export const link: TgCommand = {
  name: SPEC.link.name,
  description: SPEC.link.description,
  execute: runLink,
};

export const unlink: TgCommand = {
  name: SPEC.unlink.name,
  description: SPEC.unlink.description,
  execute: runUnlink,
};
