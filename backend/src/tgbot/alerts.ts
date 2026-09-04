// OCT alerts → Telegram chats, under a delivery policy.
//
// WHY THIS SEAM. Every alert in OCT funnels through WsServer.broadcastAlert,
// and bot/alerts.ts already proved that subscribing to it costs nothing at the
// emission sites. This is the same subscription for a second transport — no
// ingestion code knows a Telegram bot exists.
//
// WHAT CHANGED, AND WHY. The first release matched contract detections and
// delivered one message per event to every registered chat, with the
// subscription ON by default. Contract detection is the loudest event class in
// the product, so the first real group the bot joined was flooded and the bot
// was disabled in production. The seam was never the problem; the policy above
// it was. Four things now sit between an alert and a chat, and an alert has to
// clear all four:
//
//   1. CLASSIFICATION (alertPolicy.ts) — which subscribable class is this?
//   2. SUBSCRIPTION — has this chat explicitly opted into that class? A chat
//      that has only run /start is subscribed to nothing and stops here.
//   3. THE GUARD (guard.ts) — a ceiling of ten messages an hour per chat, and
//      a circuit breaker that auto-mutes a chat being flooded. This is the
//      layer that makes the NEXT mis-specification survivable: it does not care
//      why the volume is wrong.
//   4. DELIVERY — digest by default (one periodic summary), per-event only for
//      a class that asked for it and is allowed to have it.
//
// Best-effort throughout: this never throws, and a delivery failure only logs.
// A Telegram outage must not touch the console ping the alert already produced.

import { getChatStore } from './chatStore.js';
import {
  ALERT_CATALOG,
  applyMute,
  classifyAlert,
  isContractDetection,
  isMuted,
  type AlertLike,
  type TgAlertType,
} from './alertPolicy.js';
import { DigestBuffer, type DigestEntry } from './digest.js';
import { ChatOutboundGuard, readGuardLimits } from './guard.js';
import { digestLineFor, renderAlertCard, renderDigest, type ContractAlertView } from './render.js';
import { alertMatchesSource, readDefaultAlertSource, resolveAlertSource } from './source.js';
import type { TelegramSender } from './sender.js';
import type { TgChatRecord } from './chatStore.js';

export type { AlertLike };
// Re-exported from alertPolicy so the classification rule has one home while
// the historic import path keeps working.
export { isContractDetection };

/** Flatten an alert into the fields a card renders. Pure; exported for tests. */
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
 * The coalescing key for a digest entry.
 *
 * The first contract address when there is one: the same mint crossing three
 * channels in a minute is one call, and a digest that lists it three times is
 * the flood with extra steps. Falls back to the reason text so classes that
 * carry no address (a keyword match on a chatty message) still collapse when
 * they are genuinely identical.
 */
export function digestKey(type: TgAlertType, view: ContractAlertView): string {
  const address = view.addresses[0];
  return `${type}:${address ?? view.reason.slice(0, 120)}`;
}

/**
 * The fan-out. One per process, owned by index.ts.
 *
 * `getSender` is a thunk rather than a value so the listener can be registered
 * at boot, before (or without) the bot itself starting — exactly how
 * bot/alerts.ts takes `getClient`. No sender means no bot, and the alert is
 * dropped silently, which is correct for an optional subsystem.
 */
export class TgAlertRouter {
  private readonly guard: ChatOutboundGuard;
  private readonly buffer = new DigestBuffer();

  constructor(private readonly getSender: () => TelegramSender | null) {
    this.guard = new ChatOutboundGuard(readGuardLimits());
  }

  /** The WsServer.onAlert listener. Never rejects. */
  listener(): (alert: AlertLike, userId?: string) => Promise<void> {
    return (alert, userId) => this.handle(alert, userId);
  }

  /**
   * Route one alert to every chat that asked for it.
   *
   * Nothing here awaits a delivery: the sender is what paces, and making the
   * alert seam wait on Telegram would hold up the WS broadcast behind it.
   */
  async handle(alert: AlertLike, userId?: string, now: number = Date.now()): Promise<void> {
    const sender = this.getSender();
    if (!sender) return;

    const type = classifyAlert(alert);
    if (!type) return;

    try {
      const chats = await getChatStore().listEnabled();
      if (chats.length === 0) return;

      const fallbackSource = readDefaultAlertSource();
      const recipients = chats.filter(
        (chat) =>
          chat.settings.alerts[type] !== 'off' &&
          alertMatchesSource(userId, resolveAlertSource(chat, fallbackSource)),
      );
      if (recipients.length === 0) return;

      // Rendered once per class, not once per chat: the card is identical
      // everywhere and the addresses it formats are the same strings.
      const view = buildContractAlertView(alert);
      const key = digestKey(type, view);

      for (const chat of recipients) {
        await this.route(chat, type, view, key, now);
      }
    } catch (err) {
      // Only the roster read and the mute write can land here — sender.send
      // never rejects.
      console.error('[TgBot] Alert delivery failed:', (err as Error)?.message ?? err);
    }
  }

  /** One alert, one chat. Split out so `handle` reads as the policy it is. */
  private async route(
    chat: TgChatRecord,
    type: TgAlertType,
    view: ContractAlertView,
    key: string,
    now: number,
  ): Promise<void> {
    const sender = this.getSender();
    if (!sender) return;

    // A muted chat is dropped before the breaker counts it: it is already the
    // thing the breaker would ask for, and re-counting it would keep the mute
    // rolling forward forever on a feed that has not calmed down.
    if (isMuted(chat.settings, now)) {
      this.buffer.discard(chat.chatId);
      return;
    }

    // Counted whatever the delivery mode: the breaker watches UPSTREAM volume,
    // and a digest entry is exactly as much evidence of a flood as a send.
    const event = this.guard.noteEvent(chat.chatId, now);
    if (event.tripped) {
      await this.trip(chat, event.events, event.muteUntil);
      return;
    }

    if (chat.settings.alerts[type] === 'instant') {
      const decision = this.guard.admitSend(chat.chatId, now, chat.settings.mutedUntil);
      if (!decision.allow) {
        console.warn(
          `[TgBot] Chat ${chat.chatId} is at its hourly ceiling (${decision.used}/${decision.limit}); ` +
            `dropped an instant ${type} alert.`,
        );
        return;
      }
      const card = renderAlertCard(ALERT_CATALOG[type].label, view);
      void sender.send(chat.chatId, card).catch(() => {
        /* sender never rejects; belt-and-braces */
      });
      return;
    }

    const entry: DigestEntry = { type, key, line: digestLineFor(type, view) };
    if (!this.buffer.add(chat.chatId, entry, now)) {
      // Counted in the digest itself as "+N more"; this is the log half.
      console.warn(`[TgBot] Digest for chat ${chat.chatId} is full; dropped a ${type} entry.`);
    }
  }

  /**
   * The circuit breaker fired for one chat.
   *
   * Muting is PERSISTED, not held in memory: a restart loop is one of the ways
   * a chat gets flooded in the first place, and a mute that a deploy clears is
   * not a safety net. /status reads the same field and tells the chat how to
   * lift it.
   */
  private async trip(chat: TgChatRecord, events: number, muteUntil: number): Promise<void> {
    const reason = `${events} alerts in under a minute`;
    console.error(
      `[TgBot] CIRCUIT BREAKER: chat ${chat.chatId} received ${events} alerts inside the breaker ` +
        `window and has been auto-muted until ${new Date(muteUntil).toISOString()}. ` +
        'This means an alert class is far louder than its subscription assumed — check the ' +
        "chat's /alerts subscriptions before unmuting.",
    );

    // Whatever was buffered belongs to the flood; it is not worth delivering.
    this.buffer.discard(chat.chatId);

    const stored = await getChatStore().updateSettings(
      chat.chatId,
      applyMute(chat.settings, muteUntil, reason),
    );
    if (!stored) {
      console.error(
        `[TgBot] Could not persist the auto-mute for chat ${chat.chatId} — it will resume on the ` +
          'next roster refresh. Unset TELEGRAM_BOT_TOKEN if it keeps sending.',
      );
    }
  }

  /**
   * Send every pending digest. Called on a timer by index.ts.
   *
   * Order of operations matters: the batch is TAKEN first and only then offered
   * to the ceiling. A refused digest is therefore dropped rather than carried
   * into the next window — carrying it would rebuild the unbounded queue the
   * digest exists to avoid, and a twenty-minute-old detection is not news.
   */
  async flush(now: number = Date.now()): Promise<void> {
    const sender = this.getSender();
    if (!sender) return;

    const pendingIds = this.buffer.pendingChats();
    if (pendingIds.length === 0) return;

    try {
      const chats = await getChatStore().listEnabled();
      const byId = new Map(chats.map((c) => [c.chatId, c]));

      for (const chatId of pendingIds) {
        const chat = byId.get(chatId);
        // Disabled, deleted, or muted since the entries were buffered.
        if (!chat || isMuted(chat.settings, now)) {
          this.buffer.discard(chatId);
          continue;
        }

        const pending = this.buffer.take(chatId);
        if (!pending) continue;

        const decision = this.guard.admitSend(chatId, now, chat.settings.mutedUntil);
        if (!decision.allow) {
          console.warn(
            `[TgBot] Chat ${chatId} is at its hourly ceiling (${decision.used}/${decision.limit}); ` +
              `dropped a digest of ${pending.lines.length} line(s).`,
          );
          continue;
        }

        void sender.send(chatId, renderDigest(pending, now)).catch(() => {
          /* sender never rejects; belt-and-braces */
        });
      }
    } catch (err) {
      console.error('[TgBot] Digest flush failed:', (err as Error)?.message ?? err);
    } finally {
      this.guard.prune(now);
    }
  }
}
