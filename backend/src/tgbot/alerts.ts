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
import {
  digestLineFor,
  mcapCrossDigestLine,
  mcapCrossQuickBuyKeyboard,
  octSignalDigestLine,
  renderAlertCard,
  renderDigest,
  renderMcapCrossCard,
  renderOctSignalCard,
  type ContractAlertView,
  type McapCrossView,
} from './render.js';
import type { OctSignalView } from './octSignals.js';
import type { TgInlineKeyboardMarkup } from './types.js';
import {
  alertMatchesSource,
  chatsPassingSignalFilters,
  readDefaultAlertSource,
  resolveAlertSource,
  type SignalFilterGate,
} from './source.js';
import type { TelegramSender } from './sender.js';
import type { TgChatRecord } from './chatStore.js';

export type { AlertLike };
// Re-exported from alertPolicy so the classification rule has one home while
// the historic import path keeps working.
export { isContractDetection };

/** The in-memory delivery figures the /start panel renders. */
export interface PanelDelivery {
  usedThisHour: number;
  pending: { line: string; count: number }[];
  pendingDropped: number;
}

/** What the panel shows when no fan-out exists: nothing sent, nothing queued. */
const NO_DELIVERY: PanelDelivery = { usedThisHour: 0, pending: [], pendingDropped: 0 };

/**
 * The live fan-out, for the two callers that need to READ its counters without
 * owning it: the panel's home card and its Queued card.
 *
 * index.ts owns the router's lifecycle (one per process, never torn down — see
 * the note there), and both panel entry points sit downstream of it, so a
 * direct import would be a cycle. This is the narrow door instead: a setter
 * index.ts calls once, and a getter that answers honestly when the bot has
 * never started rather than constructing a fan-out as a side effect of
 * rendering a card.
 */
let panelSource: TgAlertRouter | null = null;

export function setPanelDeliverySource(router: TgAlertRouter): void {
  panelSource = router;
}

export function panelDeliveryFor(chatId: number, now: number = Date.now()): PanelDelivery {
  return panelSource ? panelSource.panelDelivery(chatId, now) : NO_DELIVERY;
}

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
 * One event, already rendered for both delivery modes.
 *
 * The card is a thunk because per-event delivery is the rare path: a chat on
 * the default digest setting never pays to build the full card, and on a busy
 * feed that is nearly every chat.
 */
interface RenderedEvent {
  /** Digest coalescing key — see digestKey. */
  key: string;
  card: () => string;
  line: string;
  /**
   * The inline keyboard for the INSTANT card, when this event has one (today:
   * the crossing card's quick-buy venues). Digest delivery is line-based and
   * ignores it — a keyboard per row would turn a digest into a link farm.
   */
  replyMarkup?: TgInlineKeyboardMarkup;
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
      const rendered: RenderedEvent = {
        key: digestKey(type, view),
        card: () => renderAlertCard(ALERT_CATALOG[type].label, view),
        line: digestLineFor(type, view),
      };

      for (const chat of recipients) {
        await this.route(chat, type, rendered, now);
      }
    } catch (err) {
      // Only the roster read and the mute write can land here — sender.send
      // never rejects.
      console.error('[TgBot] Alert delivery failed:', (err as Error)?.message ?? err);
    }
  }

  /**
   * Deliver one POLLER-RAISED signal to every chat that asked for it.
   *
   * WHY THIS EXISTS ALONGSIDE `handle`. `handle` starts from an AlertLike — a
   * message somebody posted, which WsServer.onAlert observed — and its first
   * job is to work out which subscribable class that message belongs to. A
   * market-cap crossing has no message and no classification question: the
   * poller already knows exactly what it raised. So it enters here with the
   * class named, and from that point on takes the IDENTICAL path — the same
   * subscription check, the same circuit breaker, the same hourly ceiling, the
   * same digest-by-default. Nothing about the flood protections is bypassed;
   * only the classification step, which would have nothing to classify.
   *
   * The alternative — synthesising a fake FrontendMessage so a poller event
   * could travel as an AlertLike — would put a chat message that never existed
   * into every downstream consumer of that seam. Widening the seam honestly is
   * the cheaper lie to not tell.
   *
   * `gate` IS THE PER-USER FILTER LAYER, applied at DELIVERY. The poller has
   * already decided (once, globally) what crossed and what it cost; this asks,
   * per chat, whether the OCT user that chat is sourced from wants it. See
   * `chatsPassingSignalFilters` — including what happens when a chat resolves
   * to nobody, which is "exactly what it got yesterday". Omitting the gate
   * keeps the pre-filter behaviour, which is what every existing caller and
   * test expects.
   */
  async handleSignal(
    view: McapCrossView,
    gate?: SignalFilterGate,
    now: number = Date.now(),
  ): Promise<void> {
    const sender = this.getSender();
    if (!sender) return;

    const type: TgAlertType = 'mcapCross';
    try {
      const chats = await getChatStore().listEnabled();
      const subscribed = chats.filter((chat) => chat.settings.alerts[type] !== 'off');
      if (subscribed.length === 0) return;

      // Subscription first, filters second. A chat that never opted into the
      // class must not cost a filter read, and the ordering also means a filter
      // failure can only ever REMOVE a recipient the subscription allowed.
      const recipients = gate
        ? await chatsPassingSignalFilters(subscribed, readDefaultAlertSource(), gate)
        : subscribed;
      if (recipients.length === 0) return;

      // One address is one crossing; two chains cannot collide because the key
      // carries the network the poller resolved.
      const rendered: RenderedEvent = {
        key: `${type}:${view.network}:${view.address}`,
        card: () => renderMcapCrossCard(view),
        line: mcapCrossDigestLine(view),
        replyMarkup: mcapCrossQuickBuyKeyboard(view),
      };

      for (const chat of recipients) {
        await this.route(chat, type, rendered, now);
      }
    } catch (err) {
      console.error('[TgBot] Crossing delivery failed:', (err as Error)?.message ?? err);
    }
  }

  /**
   * Deliver one forwarded "OCT Alerts" signal to every subscribed chat.
   *
   * WHY IT LOOKS LIKE handleSignal BUT SKIPS THE BREAKER. Like the crossing, an
   * octSignals event is class-named at the door, so it enters here rather than
   * through `handle`'s classification step. Unlike every other class, it passes
   * `countTowardBreaker: false` to `route`. That is deliberate and it does NOT
   * weaken the two protections the incident was about:
   *
   *   • the hourly CEILING still binds it — a chat receives at most maxPerHour
   *     messages whatever the source channels do, instant or digest, so a burst
   *     cannot flood;
   *   • an existing MUTE is still honoured — a muted chat is dropped before
   *     anything is sent.
   *
   * What it must not do is TRIGGER the circuit breaker. The breaker mutes the
   * WHOLE chat — every class — and this one is ON by default and bursty by
   * nature. Letting a normal scan burst trip it would silence a chat's missed
   * runners and crossings too, which is precisely the "do not auto-mute in a way
   * that kills other alerts" hazard a default-on class introduces. The ceiling,
   * not the breaker, is the right bound for a stream the operator opted everyone
   * into.
   */
  async handleOctSignal(view: OctSignalView, now: number = Date.now()): Promise<void> {
    const sender = this.getSender();
    if (!sender) return;

    const type: TgAlertType = 'octSignals';
    try {
      const chats = await getChatStore().listEnabled();
      const recipients = chats.filter((chat) => chat.settings.alerts[type] !== 'off');
      if (recipients.length === 0) return;

      const primary = view.addresses[0];
      const rendered: RenderedEvent = {
        key: `${type}:${view.network}:${primary ?? view.text.slice(0, 120)}`,
        card: () => renderOctSignalCard(view),
        line: octSignalDigestLine(view),
        // The referral quick-buy venues (chain-correct, owner code embedded by
        // the shared machinery) ride the primary address. No address → no
        // keyboard, and the text forwards on its own.
        replyMarkup: primary
          ? mcapCrossQuickBuyKeyboard({ address: primary, network: view.network })
          : undefined,
      };

      for (const chat of recipients) {
        await this.route(chat, type, rendered, now, { countTowardBreaker: false });
      }
    } catch (err) {
      console.error('[TgBot] Signal delivery failed:', (err as Error)?.message ?? err);
    }
  }

  /**
   * How many chats are subscribed to one class right now.
   *
   * Read by the market-cap crossing poller BEFORE it sweeps anything: a
   * chain-wide sweep that nobody has opted into should cost zero requests, the
   * same way the price-alert poller costs nothing with no armed alerts. A
   * roster read that fails answers 0 — erring towards not spending budget.
   */
  async subscriberCount(type: TgAlertType): Promise<number> {
    if (!this.getSender()) return 0;
    try {
      const chats = await getChatStore().listEnabled();
      return chats.filter((chat) => chat.settings.alerts[type] !== 'off').length;
    } catch {
      return 0;
    }
  }

  /**
   * What the /start panel needs to describe this chat's delivery, read
   * entirely from PROCESS MEMORY.
   *
   * Deliberately zero I/O. The panel has a Refresh button anyone in a group can
   * press, and production is already running its Supabase connection pool hot —
   * so every field the panel can answer without a query is one it must. The
   * hourly figure comes from the same guard the fan-out consults, and the
   * queued lines from the same buffer the digest flushes, so the card cannot
   * report a state the delivery path disagrees with.
   */
  panelDelivery(chatId: number, now: number = Date.now()): PanelDelivery {
    const { lines, dropped } = this.buffer.peek(chatId);
    return {
      usedThisHour: this.guard.usedThisHour(chatId, now),
      pending: lines.map((l) => ({ line: l.line, count: l.count })),
      pendingDropped: dropped,
    };
  }

  /**
   * One event, one chat. Split out so `handle` reads as the policy it is.
   *
   * `countTowardBreaker` defaults true — every class the incident was about
   * feeds the circuit breaker. octSignals passes false: see handleOctSignal for
   * why a default-on, operator-curated class must be bounded by the ceiling
   * without being able to auto-mute the chat's other subscriptions.
   */
  private async route(
    chat: TgChatRecord,
    type: TgAlertType,
    rendered: RenderedEvent,
    now: number,
    opts: { countTowardBreaker?: boolean } = {},
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
    if (opts.countTowardBreaker !== false) {
      const event = this.guard.noteEvent(chat.chatId, now);
      if (event.tripped) {
        await this.trip(chat, event.events, event.muteUntil);
        return;
      }
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
      void sender.send(chat.chatId, rendered.card(), { replyMarkup: rendered.replyMarkup }).catch(() => {
        /* sender never rejects; belt-and-braces */
      });
      return;
    }

    const entry: DigestEntry = { type, key: rendered.key, line: rendered.line };
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
