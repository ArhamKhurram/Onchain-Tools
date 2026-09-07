import { panelDeliveryFor } from '../alerts.js';
import { SPEC } from '../commandCatalog.js';
import { getChatStore } from '../chatStore.js';
import { readDigestIntervalMs } from '../digest.js';
import { readGuardLimits } from '../guard.js';
import { accountFingerprint } from '../identity.js';
import {
  buildPanelKeyboard,
  panelHomeSettings,
  readConsoleUrl,
  renderPanelHome,
  type PanelState,
} from '../panel.js';
import { readDefaultAlertSource, resolveAlertSource } from '../source.js';
import type { TgCommand } from './types.js';

/**
 * `/start` — register this chat, open the control panel, and subscribe it to
 * NOTHING.
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
 * separate, deliberate acts. The default lives in alertPolicy.ts
 * (DEFAULT_CHAT_SETTINGS, everything 'off') and this handler passes no settings
 * at all, so there is exactly one place it can go wrong.
 *
 * THE PANEL DOES NOT CHANGE THAT. It replaced a paragraph of prose because the
 * prose did not read as a product — but a keyboard is a faster way to reach the
 * same opt-in, never a shortcut past it. The card this sends renders
 * "Alerts: none", the buttons only ever open sub-views until somebody taps a
 * class, and the loudest class still costs a confirmation card. See panel.ts.
 *
 * Re-running it re-enables a chat that a 403 disabled (see chatStore.register)
 * and opens a fresh panel — which is also the documented escape from a panel
 * that has been closed or has aged past Telegram's 48-hour edit window.
 */
export const start: TgCommand = {
  name: SPEC.start.name,
  description: SPEC.start.description,

  async execute(ctx) {
    const record = await getChatStore().register({
      chatId: ctx.chatId,
      chatType: ctx.chat.type,
      title: ctx.chat.title ?? ctx.chat.username ?? ctx.chat.first_name ?? null,
      addedByTgUserId: ctx.from?.id ?? null,
    });

    // A failed registration (hosted mode without Supabase, or a DB error) still
    // gets a panel, with every storage-backed field rendered "unknown" rather
    // than as a confident default. The buttons are attached because the very
    // next Refresh may well succeed — and a bare error line with no way forward
    // is how a transient outage reads as a broken bot.
    const now = Date.now();
    const delivery = panelDeliveryFor(ctx.chatId, now);
    const state: PanelState = {
      view: 'home',
      record,
      settings: record?.settings ?? panelHomeSettings(),
      alertsRouted: record ? resolveAlertSource(record, readDefaultAlertSource()) !== null : null,
      boundAccount: accountFingerprint(record?.sourceUserId),
      // The home card shows no filters, so /start costs no filter read — the
      // same reason it reads the guard's counters from memory rather than
      // asking storage anything it does not render.
      filters: null,
      digestMinutes: Math.round(readDigestIntervalMs() / 60_000),
      maxPerHour: readGuardLimits().maxPerHour,
      usedThisHour: delivery.usedThisHour,
      pending: delivery.pending,
      pendingDropped: delivery.pendingDropped,
      now,
    };

    await ctx.reply(renderPanelHome(state, readConsoleUrl()), {
      keyboard: buildPanelKeyboard(state),
    });
  },
};
