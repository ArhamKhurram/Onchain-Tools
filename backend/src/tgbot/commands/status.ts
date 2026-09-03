import { readAllowedChatIds } from '../access.js';
import { getChatStore } from '../chatStore.js';
import { renderStatus } from '../render.js';
import { readDefaultAlertSource, resolveAlertSource } from '../source.js';
import type { TgCommand } from './types.js';

/**
 * `/status` — is this chat active, and what is it subscribed to.
 *
 * Reports the one failure mode a registered chat can silently be in: registered
 * and enabled, but with no alert source bound, so nothing will ever arrive.
 * Saying "on" there would be a lie the operator only discovers by waiting.
 */
export const status: TgCommand = {
  name: 'status',
  description: 'Show what this chat is registered for',

  async execute(ctx) {
    const record = await getChatStore().get(ctx.chatId);
    const allowlist = readAllowedChatIds();

    await ctx.reply(
      renderStatus(record, {
        alertsRouted: record !== null && resolveAlertSource(record, readDefaultAlertSource()) !== null,
        allowlisted: allowlist !== null && allowlist.has(ctx.chatId),
      }),
    );
  },
};
