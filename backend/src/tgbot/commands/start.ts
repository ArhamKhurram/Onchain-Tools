import { getChatStore } from '../chatStore.js';
import { renderStart } from '../render.js';
import type { TgCommand } from './types.js';

/**
 * `/start` — register this chat, and subscribe it to NOTHING.
 *
 * Registration is what makes a chat a tenant: until someone runs this, an
 * update from the chat is answered and then forgotten. Telegram sends /start
 * automatically the first time a user opens a bot's DM, so in a private chat
 * this is usually the very first thing that happens.
 *
 * IT MUST NOT SUBSCRIBE THE CHAT TO ANYTHING. The first release turned contract
 * detections on here, which meant "add the bot to a group" and "point OCT's
 * loudest event class at that group" were the same gesture — and the first real
 * group the bot joined got flooded. Registration and subscription are now two
 * separate, deliberate acts; the second one is /alerts. The default lives in
 * alertPolicy.ts (DEFAULT_CHAT_SETTINGS, everything 'off') and this handler
 * passes no settings at all, so there is exactly one place it can go wrong.
 *
 * Re-running it re-enables a chat that a 403 disabled (see chatStore.register).
 */
export const start: TgCommand = {
  name: 'start',
  description: 'Register this chat for OCT alerts',

  async execute(ctx) {
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const record = await getChatStore().register({
      chatId: ctx.chatId,
      chatType: ctx.chat.type,
      title: ctx.chat.title ?? ctx.chat.username ?? ctx.chat.first_name ?? null,
      addedByTgUserId: ctx.from?.id ?? null,
    });

    if (!record) {
      // Storage is unavailable (hosted mode without Supabase, or a DB error).
      // Say so rather than confirming a registration that did not happen.
      await ctx.reply(
        'Could not register this chat right now — OCT storage is unavailable. Try again in a minute.',
      );
      return;
    }

    await ctx.reply(renderStart(record.title, isGroup));
  },
};
