import { applyAlertSetting, clearMute, isMuted, parseAlertsCommand } from '../alertPolicy.js';
import { getChatStore } from '../chatStore.js';
import { readDigestIntervalMs } from '../digest.js';
import { readGuardLimits } from '../guard.js';
import { escapeHtml, joinLines } from '../html.js';
import {
  footer,
  renderAlertChange,
  renderAlertSettings,
  renderAlertsUsage,
  renderVolumeWarning,
} from '../render.js';
import type { TgCommand } from './types.js';

/**
 * `/alerts` — what this chat receives, and how to change it.
 *
 * THE COMMAND THAT MAKES FAIL-CLOSED USABLE. /start subscribes a chat to
 * nothing, which is only a good design if there is an obvious way to subscribe
 * to something. This is it, and it is deliberately the same command for reading
 * and writing: a group that wants to know why it is quiet runs `/alerts` and
 * sees both the answer and the fix in one card.
 *
 * The parsing is pure and lives in alertPolicy.ts; everything here is the store
 * round-trip around it.
 */
export const alerts: TgCommand = {
  name: 'alerts',
  description: 'See and change what alerts this chat receives',

  async execute(ctx) {
    const store = getChatStore();
    const record = await store.get(ctx.chatId);

    // Nothing to configure on a chat that is not a tenant yet, and registering
    // it as a side effect of /alerts would be the same fail-open mistake in a
    // new place.
    if (!record) {
      await ctx.reply(
        joinLines([
          escapeHtml('This chat is not registered yet. Run /start first.'),
          footer(),
        ]),
      );
      return;
    }

    const digestMinutes = Math.round(readDigestIntervalMs() / 60_000);
    const { maxPerHour } = readGuardLimits();
    const now = Date.now();
    const action = parseAlertsCommand(ctx.command.args);

    if (action.kind === 'usage') {
      await ctx.reply(renderAlertsUsage(action.problem));
      return;
    }

    if (action.kind === 'show') {
      await ctx.reply(renderAlertSettings(record.settings, { digestMinutes, maxPerHour, now }));
      return;
    }

    if (action.kind === 'unmute') {
      if (!isMuted(record.settings, now)) {
        await ctx.reply(joinLines([escapeHtml('This chat is not muted.'), footer()]));
        return;
      }
      const stored = await store.updateSettings(ctx.chatId, clearMute(record.settings));
      await ctx.reply(
        joinLines([
          escapeHtml(
            stored
              ? 'Unmuted. Alerts will resume — turn the loud class off if you have not already.'
              : 'Could not unmute right now — OCT storage is unavailable. Try again in a minute.',
          ),
          footer(),
        ]),
      );
      return;
    }

    // Subscribing to the loudest class costs a second command. `/alerts on
    // contracts` alone returns the volume warning and changes NOTHING —
    // turning something off never needs confirming, only turning it on.
    if (
      action.delivery !== 'off' &&
      action.spec.requiresConfirmation &&
      !action.confirmed &&
      record.settings.alerts[action.spec.type] === 'off'
    ) {
      await ctx.reply(renderVolumeWarning(action.spec.type));
      return;
    }

    const stored = await store.updateSettings(
      ctx.chatId,
      applyAlertSetting(record.settings, action.spec.type, action.delivery),
    );
    if (!stored) {
      // Say so rather than confirming a subscription change that did not
      // happen — a chat that thinks it is unsubscribed and is not is exactly
      // the failure this whole change is about.
      await ctx.reply(
        joinLines([
          escapeHtml('Could not save that right now — OCT storage is unavailable. Try again in a minute.'),
          footer(),
        ]),
      );
      return;
    }

    await ctx.reply(renderAlertChange(action.spec.type, action.delivery, digestMinutes));
  },
};
