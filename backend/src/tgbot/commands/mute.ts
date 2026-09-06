import { applyMute, clearMute, isMuted, parseMuteCommand } from '../alertPolicy.js';
import { getChatStore } from '../chatStore.js';
import { SPEC } from '../commandCatalog.js';
import { escapeHtml, joinLines } from '../html.js';
import { footer, renderMuted, renderMuteUsage } from '../render.js';
import type { TgCommand, TgCommandContext } from './types.js';

/**
 * `/mute [30m|2h|1d]` and `/unmute` — a hand on the volume, without touching
 * the subscriptions.
 *
 * WHY THIS EXISTS SEPARATELY FROM /alerts off. Turning a class off is a
 * decision about what this chat wants; muting is a decision about the next two
 * hours. Making somebody express the second as the first means they turn three
 * classes off during a meeting and remember to turn two of them back on — and
 * the class they forget is the one they wanted most. The mute is a deadline the
 * chat forgets on its own.
 *
 * IT REUSES THE CIRCUIT BREAKER'S MACHINERY EXACTLY. `settings.mutedUntil` is
 * the field the breaker already writes and `ChatOutboundGuard.admitSend`
 * already honours, so a manual mute drops alerts and discards buffered digests
 * through the same path a tripped breaker does. Nothing new can go wrong at
 * delivery time, and `/unmute` lifts either kind — which is why it is an alias
 * of `/alerts unmute` rather than a second, subtly different escape hatch.
 *
 * COMMAND REPLIES ARE NOT MUTED. The guard sits in the alert fan-out
 * (alerts.ts), not in sender.ts, so a muted chat can still run /status and
 * /unmute. A mute that silenced the way out of itself would be a trap.
 *
 * ADMIN-GATED IN A GROUP, like every other write — see permissions.ts. Muting
 * is the one write where that matters most in the other direction: any member
 * being able to silence a room's alerts is the same authority as subscribing it.
 */
async function setMute(ctx: TgCommandContext, durationMs: number | null): Promise<void> {
  const store = getChatStore();
  const record = await store.get(ctx.chatId);

  // Same reasoning as /alerts: a chat that is not a tenant has no settings to
  // change, and registering it as a side effect of /mute would be the
  // fail-open mistake in a new place.
  if (!record) {
    await ctx.reply(
      joinLines([escapeHtml('This chat is not registered yet. Run /start first.'), footer()]),
    );
    return;
  }

  const authorized = await ctx.authorizeWrite();
  if (!authorized.allow) {
    await ctx.reply(joinLines([escapeHtml(authorized.message), footer()]));
    return;
  }

  const now = Date.now();

  if (durationMs === null) {
    if (!isMuted(record.settings, now)) {
      await ctx.reply(joinLines([escapeHtml('This chat is not muted.'), footer()]));
      return;
    }
    const stored = await store.updateSettings(ctx.chatId, clearMute(record.settings));
    await ctx.reply(
      joinLines([
        escapeHtml(
          stored
            ? 'Unmuted. Alerts resume from the next event.'
            : 'Could not unmute right now — OCT storage is unavailable. Try again in a minute.',
        ),
        footer(),
      ]),
    );
    return;
  }

  const until = now + durationMs;
  const stored = await store.updateSettings(
    ctx.chatId,
    // The reason is a fixed string, never the sender's name or any other
    // attacker-controlled text: it is echoed by /status and the panel, and the
    // one field in settings that a person can write is not the place to start.
    applyMute(record.settings, until, 'muted from Telegram'),
  );

  // Say so rather than confirming a mute that did not land — a chat that thinks
  // it is quiet and is not is the failure this whole area is careful about.
  await ctx.reply(
    stored
      ? renderMuted(until)
      : joinLines([
          escapeHtml('Could not mute right now — OCT storage is unavailable. Try again in a minute.'),
          footer(),
        ]),
  );
}

export const mute: TgCommand = {
  name: SPEC.mute.name,
  description: SPEC.mute.description,

  async execute(ctx) {
    const action = parseMuteCommand(ctx.command.args);
    if (action.kind === 'usage') {
      await ctx.reply(renderMuteUsage(action.problem));
      return;
    }
    await setMute(ctx, action.durationMs);
  },
};

export const unmute: TgCommand = {
  name: SPEC.unmute.name,
  description: SPEC.unmute.description,

  async execute(ctx) {
    await setMute(ctx, null);
  },
};
