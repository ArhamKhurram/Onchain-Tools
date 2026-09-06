// Telegram Bot API transport. Plain `fetch` over https://api.telegram.org.
//
// TWO PROPERTIES ARE STRUCTURAL, NOT STYLISTIC:
//
//  1. IT NEVER REJECTS. Every method resolves to a TgCallResult. The poll loop
//     and the alert fan-out both run unattended for weeks; a DNS blip or a
//     Telegram 500 must read as a value they can branch on, not an exception
//     that escapes an async callback and takes the backend's process down.
//     This mirrors bot/dm.ts, which made the same call for Discord DMs.
//
//  2. THE TOKEN NEVER APPEARS IN A LOG LINE. It is a path segment in every
//     request URL (that is how the Bot API authenticates), so no code here may
//     log a URL, and `describeError` below reports the METHOD name instead.
//     `redactToken` is the backstop for anything that slips through — Telegram
//     itself echoes the URL in some error bodies.

import type {
  TgApiResponse,
  TgCallResult,
  TgChatMember,
  TgInlineKeyboardMarkup,
  TgMessage,
  TgUpdate,
  TgUser,
} from './types.js';

const API_ROOT = 'https://api.telegram.org';

/** Non-polling calls: generous, but bounded. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Slack the HTTP timeout gets over the long-poll's own `timeout` parameter.
 * Telegram returns an empty result at its deadline; the socket-level timeout
 * exists only for the case where that response never arrives.
 */
const POLL_TIMEOUT_SLACK_MS = 10_000;

/**
 * Strip a bot token out of an arbitrary string. Tokens are `<digits>:<35 or so
 * base64url chars>` and appear in URLs as `/bot<token>/method`.
 */
export function redactToken(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
}

/**
 * A bot token has the shape `123456789:AA…`. Checked at boot so a pasted
 * placeholder or a truncated secret fails loudly at startup instead of as a
 * 401 on every poll for the life of the process.
 */
export function looksLikeBotToken(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

export class TelegramBotApi {
  /** Held only here; never returned, never logged, never serialized. */
  private readonly token: string;

  constructor(token: string) {
    this.token = token.trim();
  }

  /**
   * One Bot API call. Resolves with an outcome; never rejects.
   *
   * `signal` lets the caller cancel an in-flight long poll at shutdown; the
   * per-call timeout is layered on top of it with a plain controller rather
   * than AbortSignal.any(), which Node 20 only grew in a patch release.
   */
  async call<T>(
    method: string,
    payload?: Record<string, unknown>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<TgCallResult<T>> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    opts?.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });

      // A Bot API error still carries the JSON envelope, so parse before
      // branching on status — that is where retry_after lives.
      let body: TgApiResponse<T> | null = null;
      try {
        body = (await res.json()) as TgApiResponse<T>;
      } catch {
        body = null;
      }

      if (body?.ok && body.result !== undefined) {
        return { ok: true, result: body.result, errorCode: 0 };
      }

      return {
        ok: false,
        errorCode: body?.error_code ?? res.status,
        description: body?.description ? redactToken(body.description) : `HTTP ${res.status}`,
        retryAfterSec: body?.parameters?.retry_after,
      };
    } catch (err) {
      // Transport failure (abort, DNS, TLS, socket) — errorCode 0 marks it as
      // "not Telegram's answer", which the caller retries rather than treating
      // as a permanent rejection like a 403.
      return {
        ok: false,
        errorCode: 0,
        description: redactToken((err as Error)?.message ?? String(err)),
      };
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Identity check at boot; also how the bot learns its own @username. */
  async getMe(signal?: AbortSignal): Promise<TgCallResult<TgUser>> {
    return this.call<TgUser>('getMe', {}, { signal });
  }

  /**
   * Long-poll for updates.
   *
   * `offset` is the confirmation mechanism, not a cursor into history: sending
   * `lastUpdateId + 1` is what tells Telegram the previous batch was processed
   * and may be dropped. Skip it and every restart replays the same updates.
   *
   * `allowed_updates` is narrowed to the two kinds the bot acts on: messages,
   * and the inline-keyboard presses the /start panel produces. It is an
   * explicit list rather than an omission because omitting it makes Telegram
   * apply whatever the last-set default was — including one set by a previous
   * deploy — and a panel whose buttons silently do nothing is indistinguishable
   * from a bug in the handler. Inline mode, reactions, edits, chat-member
   * updates and polls stay unsubscribed: bandwidth spent to be ignored.
   */
  async getUpdates(
    offset: number,
    pollSeconds: number,
    signal?: AbortSignal,
  ): Promise<TgCallResult<TgUpdate[]>> {
    return this.call<TgUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: pollSeconds,
        limit: 100,
        allowed_updates: ['message', 'callback_query'],
      },
      { timeoutMs: pollSeconds * 1000 + POLL_TIMEOUT_SLACK_MS, signal },
    );
  }

  /**
   * Send one HTML-formatted message.
   *
   * Link previews are off everywhere: an alert card that expands into a
   * full-width DexScreener preview pushes the next alert off the screen, and in
   * a busy group that is the difference between a readable feed and a wall.
   */
  async sendMessage(
    chatId: number,
    text: string,
    opts?: {
      disableNotification?: boolean;
      replyMarkup?: TgInlineKeyboardMarkup;
      signal?: AbortSignal;
    },
  ): Promise<TgCallResult<TgMessage>> {
    return this.call<TgMessage>(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        disable_notification: opts?.disableNotification ?? false,
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      },
      { signal: opts?.signal },
    );
  }

  /**
   * Replace the text and keyboard of a message the bot already sent.
   *
   * THE PANEL EDITS, IT DOES NOT POST. Every button press rewrites the one card
   * in place, so a chat that has pressed twenty buttons still holds exactly one
   * OCT message — the alternative is a bot that answers a tap with a new
   * message and buries the conversation it is sitting in.
   *
   * Callers must treat `isNotModified` as success; see the note there.
   */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { replyMarkup?: TgInlineKeyboardMarkup; signal?: AbortSignal },
  ): Promise<TgCallResult<TgMessage | boolean>> {
    return this.call<TgMessage | boolean>(
      'editMessageText',
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        // An absent reply_markup CLEARS the keyboard, which is what closing the
        // panel wants and what every other edit must avoid — so it is always
        // passed explicitly by the caller, never defaulted here.
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      },
      { signal: opts?.signal },
    );
  }

  /**
   * Acknowledge one callback query.
   *
   * MANDATORY ON EVERY PATH. Until this call lands, the pressing client shows a
   * spinner on the button — for up to a minute — so a handler that returns
   * early on an error leaves a visibly hung UI. `showAlert` turns the ephemeral
   * toast into a modal, which is what a refusal wants: a permission denial that
   * flashes for a second and vanishes reads as the button being broken.
   *
   * `text` is capped at 200 characters by Telegram and is PLAIN text — no
   * parse_mode exists for it — so nothing HTML-escaped may be passed here.
   */
  async answerCallbackQuery(
    callbackQueryId: string,
    opts?: { text?: string; showAlert?: boolean; signal?: AbortSignal },
  ): Promise<TgCallResult<boolean>> {
    return this.call<boolean>(
      'answerCallbackQuery',
      {
        callback_query_id: callbackQueryId,
        ...(opts?.text ? { text: opts.text.slice(0, 200) } : {}),
        show_alert: opts?.showAlert ?? false,
      },
      { signal: opts?.signal },
    );
  }

  /**
   * One member's status in a chat — the panel's admin check.
   *
   * A failure here is NOT an admin: see the fail-closed note on
   * PanelActor.isAdmin. Called at most once per user per minute thanks to the
   * cache in callbacks.ts, because it is a network round trip in the middle of
   * a button press.
   */
  async getChatMember(
    chatId: number,
    userId: number,
    signal?: AbortSignal,
  ): Promise<TgCallResult<TgChatMember>> {
    return this.call<TgChatMember>('getChatMember', { chat_id: chatId, user_id: userId }, { signal });
  }
}

/**
 * Did this edit fail only because the new content is identical to the old?
 *
 * Telegram rejects a no-op edit with a 400 whose description contains "message
 * is not modified". Pressing Refresh twice inside one digest window produces
 * exactly that, so it is an EXPECTED condition of a panel with a refresh
 * button, not a failure — logging it as an error would train the operator to
 * ignore the log line that matters.
 */
export function isNotModified(result: TgCallResult<unknown>): boolean {
  return result.errorCode === 400 && /message is not modified/i.test(result.description ?? '');
}

/** Human-readable one-liner for a failed call, safe to log. */
export function describeCallError(method: string, result: TgCallResult<unknown>): string {
  const code = result.errorCode === 0 ? 'transport' : String(result.errorCode);
  return `${method} failed (${code}): ${result.description ?? 'no description'}`;
}
