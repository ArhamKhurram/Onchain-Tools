// Inline-keyboard presses: the I/O half of the /start panel.
//
// panel.ts holds every DECISION (what a token means, who may act on it, what a
// card says). This file holds only the four things a decision cannot be: the
// Telegram round trips, the roster read, the caches that bound them, and the
// acknowledgement Telegram requires. Keeping the split sharp is what lets the
// security-critical part — "may this user press this button" — be a table of
// unit tests instead of an argument about an async function.
//
// FOUR PROPERTIES ARE STRUCTURAL HERE.
//
//  1. EVERY PATH ANSWERS THE QUERY. Telegram spins the pressed button on the
//     user's client until answerCallbackQuery lands, for up to a minute. A
//     handler that returns early — unparseable token, denied permission, dead
//     roster, thrown exception — leaves a visibly hung UI, so the answer is a
//     `finally`, not a happy-path line. It is also fired BEFORE the edit on the
//     paths that edit, because the edit is the slow call and the spinner is
//     what the person is looking at.
//
//  2. AUTHORIZATION IS PER PRESS, NOT PER PANEL. The card is a shared message;
//     in a group every member can tap it, and the callback query carries the
//     PRESSER. So each press re-reads the allowlist and, for a write, asks
//     Telegram whether that user is an admin of that chat. A getChatMember that
//     fails is a "no" — an unanswerable permission question must never resolve
//     permissively.
//
//  3. THE PANEL IS A READ SURFACE ON A HOT DATABASE. Production is already
//     running its Supabase connection pool near the limit, and Refresh is a
//     button any group member can hold down. Three things bound that, in order
//     of how much they save: the delivery figures come from PROCESS MEMORY
//     (TgAlertRouter.panelDelivery) and cost nothing; every other view is
//     served from a 15-second per-chat cache of the one column-scoped roster
//     row; and Refresh — the only action that deliberately bypasses that cache
//     — gets its own per-chat budget, six a minute, after which it answers
//     "already up to date" without touching storage. Worst case per chat per
//     minute is therefore six row reads, whatever anyone does with the button.
//
//  4. "MESSAGE IS NOT MODIFIED" IS SUCCESS. Refreshing twice inside one digest
//     window renders byte-identical HTML, and Telegram rejects that edit with a
//     400. It is the expected outcome of a refresh button, not a failure, and
//     logging it as an error is how a log stops being read.
//
// A NOTE ON WHY THESE CALLS SKIP sender.ts. That queue exists to pace MESSAGES
// into chats under Telegram's ~20-per-minute-per-group limit and to give
// command replies a lane ahead of alerts. A callback answer is not a message —
// it is an acknowledgement with a one-minute deadline that a queue behind an
// alert burst would blow — and an edit does not create a chat entry. Both are
// already bounded per chat by the press budgets below, which is the limit that
// actually applies to them.

import { isChatAllowed, readAllowedChatIds } from './access.js';
import { AdminCache } from './admin.js';
import {
  applyAlertSetting,
  ALERT_CATALOG,
  clearMute,
  isMuted,
  type TgAlertDelivery,
  type TgAlertType,
} from './alertPolicy.js';
import { isNotModified, type TelegramBotApi } from './api.js';
import { getChatStore, type TgChatRecord } from './chatStore.js';
import { readDigestIntervalMs } from './digest.js';
import { readGuardLimits } from './guard.js';
import {
  buildConfirmKeyboard,
  buildPanelKeyboard,
  decidePanelPress,
  isPanelWrite,
  needsConfirmation,
  panelHomeSettings,
  parsePanelAction,
  PANEL_STALE_MESSAGE,
  readConsoleUrl,
  renderPanelClosed,
  renderPanelConfirm,
  renderPanelView,
  type PanelAction,
  type PanelState,
  type PanelView,
} from './panel.js';
import { PerChatRateLimiter } from './sender.js';
import { readDefaultAlertSource, resolveAlertSource } from './source.js';
import type { TgCallbackQuery, TgInlineKeyboardMarkup } from './types.js';

/** How long one chat's roster row is reused across presses. */
const RECORD_CACHE_MS = 15_000;

/** Refresh presses per chat per minute. Each one costs one roster read. */
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_MAX_IN_WINDOW = 6;

/**
 * A general per-chat press budget, well above normal use.
 *
 * The refresh budget bounds STORAGE; this bounds Telegram calls, which every
 * press makes at least two of (answer + edit). Someone mashing a view button
 * costs no database work but can still make the bot look like it is spamming
 * the API, which is how a token gets throttled for everyone in it.
 */
const PRESS_WINDOW_MS = 10_000;
const PRESS_MAX_IN_WINDOW = 10;

/** Beyond this many cached entries the map is pruned. Bounds a long uptime. */
const CACHE_PRUNE_AT = 500;

/** What the handler needs from the rest of the bot. Injected, never imported. */
export interface CallbackDeps {
  api: TelegramBotApi;
  /**
   * Whether a user may perform a write here. Shared with the typed commands so
   * the answer is cached once per user per minute across both surfaces — and so
   * the fail-closed rule has one implementation. See admin.ts.
   */
  admins: AdminCache;
  /**
   * The bot's own @username from getMe, or '' when Telegram gave none. Only the
   * Help card reads it; it is threaded rather than imported because a renderer
   * that reached for module state would be a renderer this file could not test.
   */
  botUsername: string;
  /**
   * In-memory delivery figures for one chat — see TgAlertRouter.panelDelivery.
   * A thunk because the router is owned by index.ts and may not exist yet.
   */
  delivery(
    chatId: number,
    now: number,
  ): { usedThisHour: number; pending: { line: string; count: number }[]; pendingDropped: number };
}

interface CachedRecord {
  record: TgChatRecord | null;
  expiresAt: number;
}

/**
 * The per-process caches and budgets.
 *
 * A class rather than module globals so a test can build a fresh one, and so
 * the pruning has somewhere to live. index.ts holds exactly one.
 */
export class PanelCallbackHandler {
  private readonly records = new Map<number, CachedRecord>();
  private readonly refreshes = new PerChatRateLimiter(REFRESH_WINDOW_MS, REFRESH_MAX_IN_WINDOW);
  private readonly presses = new PerChatRateLimiter(PRESS_WINDOW_MS, PRESS_MAX_IN_WINDOW);

  constructor(private readonly deps: CallbackDeps) {}

  /**
   * Handle one callback query. Never rejects.
   *
   * The shape is one long guarded path with a single `finally` that answers the
   * query, because the answer is the only thing that MUST happen on every exit.
   * `answerText` and `answerAlert` are what the guards write into.
   */
  async handle(query: TgCallbackQuery, now: number = Date.now()): Promise<void> {
    let answerText: string | undefined;
    let answerAlert = false;

    try {
      const message = query.message;
      const chat = message?.chat;
      // Telegram stops attaching the message once it is older than 48 hours, so
      // there is nothing to edit and no chat to authorize against. That is a
      // real, expected state of a panel somebody left open over a weekend.
      if (!message || !chat) {
        answerText = PANEL_STALE_MESSAGE;
        answerAlert = true;
        return;
      }

      const chatId = chat.id;

      // Untrusted input, parsed by whitelist. A null here is a token from a
      // previous encoding version or one that never came from us at all; both
      // get the same honest answer and change nothing.
      const action = parsePanelAction(query.data);
      if (!action) {
        answerText = PANEL_STALE_MESSAGE;
        answerAlert = true;
        return;
      }

      // Cheapest gate first: mashing costs one answer and no further work.
      if (!this.presses.tryConsume(chatId, now)) {
        answerText = 'Too many taps — give it a second.';
        return;
      }

      const verdict = decidePanelPress(action, {
        chatId,
        chatType: chat.type,
        userId: query.from.id,
        chatAllowed: isChatAllowed(chatId, readAllowedChatIds()),
        // Resolved only for the actions that need it: a read in a group must
        // not spend a getChatMember round trip per press.
        isAdmin: isPanelWrite(action)
          ? await this.deps.admins.isAdmin(chatId, query.from.id, now)
          : false,
      });

      if (!verdict.allow) {
        // A modal, not a toast. A refusal that flashes for a second and
        // disappears is indistinguishable from a button that does nothing.
        answerText = verdict.message;
        answerAlert = true;
        return;
      }

      // Refresh is the one action allowed to bypass the record cache, and the
      // one with its own budget for exactly that reason.
      const fresh = action.kind === 'refresh';
      if (fresh && !this.refreshes.tryConsume(chatId, now)) {
        answerText = 'Already up to date — refresh again in a moment.';
        return;
      }

      const outcome = await this.apply(action, chatId, now, fresh);
      answerText = outcome.answer;

      const edit = await this.deps.api.editMessageText(chatId, message.message_id, outcome.text, {
        replyMarkup: outcome.keyboard,
      });
      if (!edit.ok && !isNotModified(edit)) {
        console.error(
          `[TgBot] Panel edit failed on chat ${chatId} (${edit.errorCode}): ${edit.description ?? 'no description'}`,
        );
        answerText = answerText ?? 'Could not update the panel right now.';
      }
    } catch (err) {
      console.error('[TgBot] Panel press failed:', (err as Error)?.message ?? err);
      answerText = 'Something went wrong. Try /start.';
      answerAlert = true;
    } finally {
      // THE mandatory call. Its own failure is logged and swallowed: there is
      // nothing left to do about a spinner we could not stop.
      const answered = await this.deps.api.answerCallbackQuery(query.id, {
        text: answerText,
        showAlert: answerAlert,
      });
      if (!answered.ok) {
        console.warn(
          `[TgBot] answerCallbackQuery failed (${answered.errorCode}): ${answered.description ?? 'no description'}`,
        );
      }
      this.prune(now);
    }
  }

  /**
   * Execute one authorized action and return the card it should leave behind.
   *
   * Writes go through the SAME pure helpers the typed commands use
   * (applyAlertSetting, clearMute, nextDelivery), so a button and a command can
   * never disagree about what a subscription change means.
   */
  private async apply(
    action: PanelAction,
    chatId: number,
    now: number,
    fresh: boolean,
  ): Promise<{ text: string; keyboard: TgInlineKeyboardMarkup | undefined; answer?: string }> {
    if (action.kind === 'close') {
      // Edited, not deleted. Deleting somebody else's chat history to close a
      // panel is a larger act than the button implies, and the one-line
      // replacement says how to get it back.
      return { text: renderPanelClosed(), keyboard: undefined };
    }

    if (action.kind === 'confirm') {
      return {
        text: renderPanelConfirm(action.type),
        keyboard: buildConfirmKeyboard(action.type),
        answer: 'Read the volume note first.',
      };
    }

    if (action.kind === 'unmute') {
      const record = await this.record(chatId, now, true);
      if (!record) return this.render('home', chatId, now, 'OCT storage is unavailable.');
      if (!isMuted(record.settings, now)) {
        return this.render('home', chatId, now, 'This chat is not muted.');
      }
      const stored = await getChatStore().updateSettings(chatId, clearMute(record.settings));
      this.records.delete(chatId);
      return this.render(
        'home',
        chatId,
        now,
        stored ? 'Unmuted.' : 'Could not unmute — OCT storage is unavailable.',
      );
    }

    if (action.kind === 'set') {
      return this.applySet(action.type, action.delivery, chatId, now);
    }

    // view / refresh — the read paths. `fresh` is what makes Refresh mean
    // something rather than re-rendering the cache.
    return this.render(action.view, chatId, now, undefined, fresh);
  }

  /**
   * Turn one alert class on or off from a button.
   *
   * THE FAIL-CLOSED CHECK IS REPEATED HERE ON PURPOSE. parsePanelAction already
   * refuses `instant` on a class that forbids it, and buildPanelKeyboard only
   * ever renders a `confirm` token for a class that demands one — but a
   * callback query is a byte string from the network, and the rule that a loud
   * class cannot be subscribed without a confirmation must hold against a
   * crafted press, not only against the keyboard we drew. So the CURRENT state
   * is re-read from storage and `needsConfirmation` is evaluated against it
   * before anything is written.
   */
  private async applySet(
    type: TgAlertType,
    delivery: TgAlertDelivery,
    chatId: number,
    now: number,
  ): Promise<{ text: string; keyboard: TgInlineKeyboardMarkup | undefined; answer?: string }> {
    const record = await this.record(chatId, now, true);
    if (!record) {
      return this.render('alerts', chatId, now, 'OCT storage is unavailable — nothing changed.');
    }

    const spec = ALERT_CATALOG[type];
    const current = record.settings.alerts[type];
    if (delivery !== 'off' && needsConfirmation(spec, current)) {
      return {
        text: renderPanelConfirm(type),
        keyboard: buildConfirmKeyboard(type),
        answer: 'Read the volume note first.',
      };
    }

    const stored = await getChatStore().updateSettings(
      chatId,
      applyAlertSetting(record.settings, type, delivery),
    );
    // Whatever happened, the cached row is now a guess. Dropping it means the
    // re-render below reads the truth rather than confirming a change that may
    // not have landed.
    this.records.delete(chatId);

    return this.render(
      'alerts',
      chatId,
      now,
      stored
        ? `${spec.label}: ${delivery === 'off' ? 'off' : delivery === 'instant' ? 'every event' : 'digest'}`
        : 'Could not save that — OCT storage is unavailable.',
      true,
    );
  }

  /** Build one view's card and keyboard from the current state. */
  private async render(
    view: PanelView,
    chatId: number,
    now: number,
    answer?: string,
    fresh = false,
  ): Promise<{ text: string; keyboard: TgInlineKeyboardMarkup | undefined; answer?: string }> {
    const state = await this.state(view, chatId, now, fresh);
    return {
      text: renderPanelView(state, readConsoleUrl(), this.deps.botUsername),
      keyboard: buildPanelKeyboard(state),
      answer,
    };
  }

  /**
   * Gather everything a card needs.
   *
   * The only storage read in the whole file is `this.record`. Every other field
   * is env (digest interval, guard limits, alert source) or process memory
   * (the guard's hourly count, the digest buffer's queued lines).
   *
   * A missing record is NOT an error path: `settings` falls back to the same
   * fail-closed default a brand-new chat has, and `alertsRouted` goes to null,
   * which the cards render as "unknown" rather than as a confident "no".
   */
  private async state(view: PanelView, chatId: number, now: number, fresh: boolean): Promise<PanelState> {
    const record = await this.record(chatId, now, fresh);
    const delivery = this.deps.delivery(chatId, now);

    return {
      view,
      record,
      settings: record?.settings ?? panelHomeSettings(),
      alertsRouted: record ? resolveAlertSource(record, readDefaultAlertSource()) !== null : null,
      digestMinutes: Math.round(readDigestIntervalMs() / 60_000),
      maxPerHour: readGuardLimits().maxPerHour,
      usedThisHour: delivery.usedThisHour,
      pending: delivery.pending,
      pendingDropped: delivery.pendingDropped,
      now,
    };
  }

  /**
   * One chat's roster row, from a short cache.
   *
   * `fresh` skips the cache — Refresh, and every write, which must decide
   * against the real current state rather than a fifteen-second-old copy. A
   * failed read is cached as `null` too: a Supabase outage that made the panel
   * retry on every press would be adding load to the thing that is down.
   */
  private async record(chatId: number, now: number, fresh: boolean): Promise<TgChatRecord | null> {
    if (!fresh) {
      const cached = this.records.get(chatId);
      if (cached && cached.expiresAt > now) return cached.record;
    }
    const record = await getChatStore().get(chatId);
    this.records.set(chatId, { record, expiresAt: now + RECORD_CACHE_MS });
    return record;
  }

  /** Drop expired cache entries once either map has grown past the threshold. */
  private prune(now: number): void {
    if (this.records.size > CACHE_PRUNE_AT) {
      for (const [chatId, entry] of this.records) {
        if (entry.expiresAt <= now) this.records.delete(chatId);
      }
    }
    this.deps.admins.prune(now);
  }
}
