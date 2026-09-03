// Contract detections → Telegram chats.
//
// WHY THIS SEAM. Every alert in OCT funnels through WsServer.broadcastAlert,
// and bot/alerts.ts already proved that subscribing to it costs nothing at the
// six emission sites. This is the same subscription for a second transport —
// no ingestion code knows a Telegram bot exists.
//
// WHY CONTRACT DETECTIONS AND NOT SOMETHING ELSE. It is the alert class the
// prospect actually asked for, it needs no per-user configuration to be
// meaningful, and it is the only one that already carries everything a group
// wants in one payload (who called it, where, and the mint). Missed-runner and
// revival are per-user tuned; pump callouts arrive through their own poller
// with their own per-caller follow graph, which a group chat has no equivalent
// of. Adding a class later is a case in `isContractDetection` plus a settings
// key — the fan-out below does not change.
//
// TWO ALERT TYPES, ONE SIGNAL. utils/frontendAlerts.ts emits `highlighted_user`
// and RETURNS for a highlighted author, so a contract posted by a highlighted
// user never produces a `contract_address` alert. Matching only the latter
// would therefore silently drop the highest-signal case in the product. Both
// are matched; both are the same detection.
//
// Best-effort throughout: this never throws, and a delivery failure only logs.
// A Telegram outage must not touch the console ping the alert already produced.

import type { FrontendMessage } from '../discord/types.js';
import { getChatStore } from './chatStore.js';
import { renderContractAlert, type ContractAlertView } from './render.js';
import { alertMatchesSource, readDefaultAlertSource, resolveAlertSource } from './source.js';
import type { TelegramSender } from './sender.js';

/** The alert shape WsServer.onAlert hands us (same as bot/alerts.ts). */
export interface AlertLike {
  type: string;
  message: FrontendMessage;
  reason: string;
}

/**
 * Is this alert a contract detection?
 *
 * A highlighted-user alert only qualifies when the message actually carried an
 * address — otherwise it is "someone you watch said something", a different
 * signal that a group has not asked for.
 */
export function isContractDetection(alert: AlertLike): boolean {
  if (alert.type === 'contract_address') return true;
  if (alert.type === 'highlighted_user') return alert.message?.hasContractAddress === true;
  return false;
}

/** Flatten an alert into the fields the card renders. Pure; exported for tests. */
export function buildContractAlertView(alert: AlertLike): ContractAlertView {
  const msg = alert.message;
  return {
    reason: alert.reason ?? '',
    author: msg?.author?.displayName ?? msg?.author?.username ?? null,
    guildName: msg?.guildName ?? null,
    channelName: msg?.channelName ?? null,
    source: msg?.source ?? null,
    content: msg?.content ?? '',
    addresses: Array.isArray(msg?.contractAddresses) ? msg.contractAddresses : [],
  };
}

/**
 * Build the WsServer.onAlert listener.
 *
 * `getSender` is a thunk rather than a value so the listener can be registered
 * at boot, before (or without) the bot itself starting — exactly how
 * bot/alerts.ts takes `getClient`. No sender means no bot; the alert is dropped
 * silently, which is the correct behaviour for an optional subsystem.
 */
export function createContractAlertListener(getSender: () => TelegramSender | null) {
  return async function deliverContractAlert(alert: AlertLike, userId?: string): Promise<void> {
    const sender = getSender();
    if (!sender || !isContractDetection(alert)) return;

    try {
      const chats = await getChatStore().listEnabled();
      if (chats.length === 0) return;

      const fallbackSource = readDefaultAlertSource();
      const recipients = chats.filter(
        (chat) =>
          chat.settings.contractAlerts &&
          alertMatchesSource(userId, resolveAlertSource(chat, fallbackSource)),
      );
      if (recipients.length === 0) return;

      // Rendered once: the card is identical for every chat, and the addresses
      // it formats are the same strings.
      const text = renderContractAlert(buildContractAlertView(alert));

      // Queued, not awaited in series — the sender is the thing that paces, and
      // making the alert seam wait on delivery would hold up the WS broadcast.
      for (const chat of recipients) {
        void sender.send(chat.chatId, text).catch(() => {
          /* sender never rejects; this is belt-and-braces */
        });
      }
    } catch (err) {
      // Only the roster read can land here — sender.send never rejects.
      console.error('[TgBot] Alert delivery failed:', (err as Error)?.message ?? err);
    }
  };
}
