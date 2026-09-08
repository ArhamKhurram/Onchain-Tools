import { subscribedTypes } from '../alertPolicy.js';
import { panelDeliveryFor } from '../alerts.js';
import { getChatStore } from '../chatStore.js';
import { SPEC } from '../commandCatalog.js';
import { readDigestIntervalMs } from '../digest.js';
import { renderQueued } from '../render.js';
import type { TgCommand } from './types.js';

/**
 * `/queued` — what this chat's next digest will contain.
 *
 * THE TYPED TWIN OF THE PANEL'S "Queued" BUTTON, and it exists because the two
 * surfaces are not interchangeable: a group where somebody else opened the
 * panel cannot press its buttons without opening a second one, and the panel
 * ages out of Telegram's 48-hour edit window. Every panel view that answers a
 * question a person can also ask in words should have a command; this is the
 * one that had none.
 *
 * IT COSTS NO STORAGE READ FOR ITS ANSWER. The buffer is process memory
 * (digest.ts, read through `peek` — never `take`, which would consume the batch
 * it is describing), and the interval is env. The single roster read is only
 * for "subscribed to nothing", which is the difference between "nothing is
 * coming" and "nothing will ever come" — the one distinction that makes the
 * empty card useful rather than confusing.
 *
 * READ-ONLY AND OPEN TO ANY MEMBER. It reveals nothing that /status does not,
 * and nothing belonging to any OCT user: the lines were rendered for THIS chat
 * from alerts THIS chat is subscribed to.
 */
export const queued: TgCommand = {
  name: SPEC.queued.name,
  description: SPEC.queued.description,

  async execute(ctx) {
    const now = Date.now();
    const delivery = panelDeliveryFor(ctx.chatId, now);
    const record = await getChatStore().get(ctx.chatId);

    await ctx.reply(
      renderQueued(
        { lines: delivery.pending, dropped: delivery.pendingDropped },
        {
          digestMinutes: Math.round(readDigestIntervalMs() / 60_000),
          // A missing roster row reads as "subscribed to nothing", which is
          // true of an unregistered chat and the safe answer during an outage.
          subscribed: record ? subscribedTypes(record.settings).length : 0,
        },
      ),
    );
  },
};
