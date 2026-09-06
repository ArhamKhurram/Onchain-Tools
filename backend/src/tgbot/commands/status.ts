import { readAllowedChatIds } from '../access.js';
import { SPEC } from '../commandCatalog.js';
import { getChatStore } from '../chatStore.js';
import { renderStatus } from '../render.js';
import { readDefaultAlertSource, resolveAlertSource } from '../source.js';
import type { TgCommand } from './types.js';

/**
 * `/status` — is this chat active, and what is it subscribed to.
 *
 * Reports the three states a registered chat can silently be quiet in, because
 * every one of them otherwise looks like a broken bot:
 *   • subscribed to nothing (the state every new chat starts in)
 *   • no alert source bound, so nothing will ever arrive
 *   • auto-muted by the circuit breaker — with the command that lifts it
 * Saying "on" for any of them would be a lie the operator discovers by waiting.
 */
export const status: TgCommand = {
  name: SPEC.status.name,
  description: SPEC.status.description,

  async execute(ctx) {
    const record = await getChatStore().get(ctx.chatId);
    const allowlist = readAllowedChatIds();

    await ctx.reply(
      renderStatus(record, {
        alertsRouted: record !== null && resolveAlertSource(record, readDefaultAlertSource()) !== null,
        allowlisted: allowlist !== null && allowlist.has(ctx.chatId),
        now: Date.now(),
      }),
    );
  },
};
