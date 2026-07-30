// OCT bot alert DMs (see docs/architecture/discord-bot.md).
//
// Every alert in OCT funnels through WsServer.broadcastAlert, so this subscribes
// to that single seam rather than touching the six emission sites. For each
// alert we check the owning user's opt-in prefs, resolve their Discord id from
// the OAuth identity OCT already stores, and DM them.
//
// Opt-in and best-effort by design:
//   • disabled by default — nobody is DMed until they turn it on in Settings
//   • never throws; a delivery failure only logs
//   • Discord only permits a DM to a user who shares a server with the bot
//     (error 50007) — that case is logged as guidance, not spam

import type { Client } from 'discord.js';
import type { DiscordBotTriggers } from '@oct/shared';
import type { FrontendMessage } from '../discord/types.js';
import { getStorageProvider } from '../storage/index.js';
import { resolveDiscordIdByOctUser } from './identity.js';
import { BRAND, botFooter, makeContainer, makeSeparator, makeText, shortAddress } from './layout.js';

const DISCORD_CANNOT_DM = 50007; // "Cannot send messages to this user"

export interface AlertLike {
  type: string;
  message: FrontendMessage;
  reason: string;
}

/** Which trigger governs an alert type; null = not deliverable by DM. */
export function triggerForAlert(alert: AlertLike): keyof DiscordBotTriggers | null {
  switch (alert.type) {
    case 'highlighted_user':
      // Mirrors the Pushover split: a highlighted user posting a contract is
      // treated as its own, higher-signal trigger.
      return alert.message?.hasContractAddress ? 'highlightedUserContract' : 'highlightedUser';
    case 'contract_address':
      return 'contract';
    case 'keyword_match':
      return 'keyword';
    case 'missed_runner':
      return 'missedRunner';
    default:
      // e.g. signal_convergence — raised client-side, never reaches the backend.
      return null;
  }
}

/** True when this user's prefs say to DM this alert. */
export function shouldDmAlert(
  alert: AlertLike,
  config: { discordBotDm?: { enabled: boolean; triggers: DiscordBotTriggers } } | null | undefined,
): boolean {
  const prefs = config?.discordBotDm;
  if (!prefs?.enabled) return false;
  const trigger = triggerForAlert(alert);
  if (!trigger) return false;
  return prefs.triggers?.[trigger] === true;
}

const ACCENTS: Record<string, number> = {
  missed_runner: BRAND.gold,
  contract_address: BRAND.blurple,
  highlighted_user: BRAND.green,
  keyword_match: BRAND.red,
};

const TITLES: Record<string, string> = {
  missed_runner: '🏃 Missed runner',
  contract_address: '💠 Contract scan',
  highlighted_user: '⭐ Highlighted user',
  keyword_match: '🔑 Keyword match',
};

/** Render an alert as a Components V2 DM payload. */
export function buildAlertDm(alert: AlertLike) {
  const msg = alert.message;
  const title = TITLES[alert.type] ?? '🔔 OCT alert';
  const accent = ACCENTS[alert.type] ?? BRAND.blurple;

  const where = [msg?.guildName, msg?.channelName].filter(Boolean).join(' · ');
  const author = msg?.author?.displayName ?? msg?.author?.username ?? null;
  const body = (msg?.content ?? '').trim();

  const addresses = (msg?.contractAddresses ?? []).slice(0, 3);
  const addressLines = addresses.map((a) => `\`${shortAddress(a)}\``).join(' · ');

  return [
    makeContainer(accent, [
      makeText(`# ${title}`),
      makeText(alert.reason),
      makeSeparator(1),
      ...(where ? [makeText(`**Where:** ${where}`)] : []),
      ...(author ? [makeText(`**From:** ${author}`)] : []),
      ...(body
        ? [makeText(body.length > 400 ? `>>> ${body.slice(0, 397)}...` : `>>> ${body}`)]
        : []),
      ...(addressLines ? [makeText(`**Contracts:** ${addressLines}`)] : []),
      makeText(botFooter('Manage these in OCT → Settings → Discord Bot')),
    ]),
  ];
}

/**
 * Register the DM delivery listener. Safe to call when the bot is disabled —
 * the listener simply finds no client and returns.
 */
export function createAlertDmListener(getClient: () => Client | null) {
  return async function deliverAlertDm(alert: AlertLike, userId?: string): Promise<void> {
    const client = getClient();
    // Local/single-user mode has no per-user identity to DM.
    if (!client || !userId || userId === 'local') return;

    try {
      const config = await getStorageProvider().getConfig(userId);
      if (!shouldDmAlert(alert, config as any)) return;

      const discordId = await resolveDiscordIdByOctUser(userId);
      if (!discordId) return; // account has no linked Discord identity

      const user = await client.users.fetch(discordId);
      await user.send({
        flags: 1 << 15, // MessageFlags.IsComponentsV2
        components: buildAlertDm(alert),
      } as any);
    } catch (err: any) {
      if (err?.code === DISCORD_CANNOT_DM) {
        console.warn(
          '[BotAlerts] Cannot DM this user — Discord requires that they share a server with the bot ' +
            '(or have DMs open). Ask them to join the OCT server.',
        );
        return;
      }
      console.error('[BotAlerts] DM delivery failed:', err?.message ?? err);
    }
  };
}
