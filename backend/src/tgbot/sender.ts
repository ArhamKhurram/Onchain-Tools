// Outbound message pacing for the Telegram bot.
//
// Telegram publishes two limits and enforces them with 429s that carry a
// `retry_after`: roughly 30 messages per second across the whole bot, and
// roughly 20 messages per minute into any one group. Exceeding the second one
// repeatedly is how a bot gets throttled for hours, which would take the
// COMMAND replies down with the alerts — so pacing is not politeness here, it
// protects the interactive surface.
//
// Four decisions worth stating:
//
//  1. ONE SERIALIZED QUEUE, TWO LANES. Everything leaves through one drain loop
//     with a global minimum gap, so the per-second ceiling is structural rather
//     than hoped for. Command replies ride a high-priority lane: a burst of
//     alerts must never make /help look broken.
//
//  2. THE PER-CHAT LIMIT DROPS, IT DOES NOT DELAY. A chat that has already had
//     its minute's worth is over budget because the feed is loud, and holding
//     the overflow just delivers a stale alert later while the queue grows.
//     Drops are counted and logged, never hidden. Same call as calloutDm.ts.
//
//  3. A 429 IS OBEYED, NOT GUESSED AT. `retry_after` is the only number that
//     matters; the message is re-queued once behind that pause.
//
//  4. A 403 IS PERMANENT. "bot was blocked", "kicked from the group", "chat not
//     found" mean there is nothing to retry — the chat is handed to the
//     onPermanentFailure callback, which disables its roster row.

import type { TelegramBotApi } from './api.js';
import type { TgCallResult, TgInlineKeyboardMarkup } from './types.js';

/** ~30/sec, with headroom. The floor gap between any two outgoing messages. */
export const GLOBAL_MIN_GAP_MS = 40;

/** The per-chat window Telegram meters. */
export const PER_CHAT_WINDOW_MS = 60_000;

/** Messages per chat per window. Under Telegram's ~20 so a burst has slack. */
export const PER_CHAT_MAX_IN_WINDOW = 18;

/** Beyond this many queued messages, new low-priority ones are dropped. */
export const MAX_QUEUE_DEPTH = 250;

/** How long a 429 pause may last before the message is dropped instead. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Sliding-window counter, one window per chat.
 *
 * Pure and clock-injected so the window arithmetic is unit-testable without
 * waiting a real minute.
 */
export class PerChatRateLimiter {
  private hits = new Map<number, number[]>();

  constructor(
    private readonly windowMs: number = PER_CHAT_WINDOW_MS,
    private readonly maxInWindow: number = PER_CHAT_MAX_IN_WINDOW,
  ) {}

  /** Record a send if the chat has budget. False means "over budget, drop it". */
  tryConsume(chatId: number, now: number): boolean {
    const cutoff = now - this.windowMs;
    const kept = (this.hits.get(chatId) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.maxInWindow) {
      this.hits.set(chatId, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(chatId, kept);
    return true;
  }

  /** Sends still counted against this chat's window. */
  used(chatId: number, now: number): number {
    const cutoff = now - this.windowMs;
    return (this.hits.get(chatId) ?? []).filter((t) => t > cutoff).length;
  }

  /** Forget chats with no recent activity, so the map cannot grow forever. */
  prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [chatId, times] of this.hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(chatId);
      else this.hits.set(chatId, kept);
    }
  }
}

/**
 * Is this failure permanent for the chat? A 403 always is (blocked, kicked,
 * deactivated) and so is a 400 that says the chat is gone. Everything else —
 * 429, 5xx, transport — is transient and worth another poll cycle.
 */
export function isPermanentChatFailure(result: TgCallResult<unknown>): boolean {
  if (result.errorCode === 403) return true;
  if (result.errorCode !== 400) return false;
  return /chat not found|group chat was upgraded|chat_id is empty/i.test(result.description ?? '');
}

interface QueueItem {
  chatId: number;
  text: string;
  /** High-priority items skip the per-chat budget: they are a user's own reply. */
  priority: 'high' | 'normal';
  disableNotification: boolean;
  /** The inline keyboard, for the one message type that has one: the panel. */
  replyMarkup?: TgInlineKeyboardMarkup;
  attempt: number;
  resolve: (delivered: boolean) => void;
}

export interface SenderOptions {
  /** Called when a chat can never be posted to again (403 and friends). */
  onPermanentFailure?: (chatId: number, reason: string) => void;
}

export class TelegramSender {
  private high: QueueItem[] = [];
  private normal: QueueItem[] = [];
  private draining = false;
  private stopped = false;
  private lastSentAt = 0;
  private droppedByBudget = 0;
  private droppedByDepth = 0;
  private readonly limiter = new PerChatRateLimiter();

  constructor(
    private readonly api: TelegramBotApi,
    private readonly options: SenderOptions = {},
  ) {}

  /**
   * Queue one message. Resolves true when Telegram accepted it, false when it
   * was dropped or permanently rejected. Never rejects.
   *
   * `priority: 'high'` is for direct answers to a command — they bypass the
   * per-chat alert budget (a person typed something and is waiting) but still
   * respect the global gap.
   */
  send(
    chatId: number,
    text: string,
    opts?: {
      priority?: 'high' | 'normal';
      disableNotification?: boolean;
      replyMarkup?: TgInlineKeyboardMarkup;
    },
  ): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);

    const priority = opts?.priority ?? 'normal';
    const depth = this.high.length + this.normal.length;
    if (priority === 'normal' && depth >= MAX_QUEUE_DEPTH) {
      this.droppedByDepth += 1;
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const item: QueueItem = {
        chatId,
        text,
        priority,
        disableNotification: opts?.disableNotification ?? false,
        replyMarkup: opts?.replyMarkup,
        attempt: 0,
        resolve,
      };
      if (priority === 'high') this.high.push(item);
      else this.normal.push(item);
      void this.drain();
    });
  }

  /** Drop everything queued and refuse new work. Called at shutdown. */
  stop(): void {
    this.stopped = true;
    for (const item of [...this.high, ...this.normal]) item.resolve(false);
    this.high = [];
    this.normal = [];
  }

  /** Counters for the boot/health log. */
  stats(): { queued: number; droppedByBudget: number; droppedByDepth: number } {
    return {
      queued: this.high.length + this.normal.length,
      droppedByBudget: this.droppedByBudget,
      droppedByDepth: this.droppedByDepth,
    };
  }

  private next(): QueueItem | undefined {
    return this.high.shift() ?? this.normal.shift();
  }

  /**
   * The single drain loop. Re-entrancy is guarded by `draining`, so however
   * many callers enqueue concurrently there is exactly one sender in flight and
   * the global gap actually holds.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      for (let item = this.next(); item !== undefined; item = this.next()) {
        if (this.stopped) {
          item.resolve(false);
          continue;
        }

        const now = Date.now();
        if (item.priority === 'normal' && !this.limiter.tryConsume(item.chatId, now)) {
          this.droppedByBudget += 1;
          // Log the first drop of a burst, not all of them.
          if (this.droppedByBudget % 10 === 1) {
            console.warn(
              `[TgBot] Chat ${item.chatId} is over its per-minute budget; dropped the message ` +
                `(${this.droppedByBudget} dropped so far this process).`,
            );
          }
          item.resolve(false);
          continue;
        }

        const gap = GLOBAL_MIN_GAP_MS - (now - this.lastSentAt);
        if (gap > 0) await sleep(gap);

        this.lastSentAt = Date.now();
        const result = await this.api.sendMessage(item.chatId, item.text, {
          disableNotification: item.disableNotification,
          replyMarkup: item.replyMarkup,
        });

        if (result.ok) {
          item.resolve(true);
          continue;
        }

        if (isPermanentChatFailure(result)) {
          this.options.onPermanentFailure?.(item.chatId, result.description ?? 'rejected');
          item.resolve(false);
          continue;
        }

        // 429 — obey retry_after, once. A second 429 on the same message means
        // the chat is genuinely saturated and the message is already stale.
        const retryMs = (result.retryAfterSec ?? 0) * 1000;
        if (result.errorCode === 429 && item.attempt === 0 && retryMs > 0 && retryMs <= MAX_RETRY_AFTER_MS) {
          console.warn(`[TgBot] Rate limited on chat ${item.chatId}; pausing ${retryMs}ms.`);
          await sleep(retryMs);
          item.attempt += 1;
          // Back to the front of its lane: it was accepted into the budget already.
          if (item.priority === 'high') this.high.unshift(item);
          else this.normal.unshift(item);
          continue;
        }

        console.error(
          `[TgBot] sendMessage to ${item.chatId} failed (${result.errorCode}): ${result.description ?? 'no description'}`,
        );
        item.resolve(false);
      }

      this.limiter.prune(Date.now());
    } catch (err) {
      // The loop is the last line of defence: anything that escapes it would be
      // an unhandled rejection inside a fire-and-forget alert path.
      console.error('[TgBot] Send queue error:', (err as Error)?.message ?? err);
    } finally {
      this.draining = false;
      // A message enqueued while the catch above was unwinding would otherwise
      // sit forever, since drain() returns early when `draining` is set.
      if (!this.stopped && (this.high.length > 0 || this.normal.length > 0)) {
        setTimeout(() => void this.drain(), GLOBAL_MIN_GAP_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
