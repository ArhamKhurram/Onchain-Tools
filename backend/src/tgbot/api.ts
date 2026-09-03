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

import type { TgApiResponse, TgCallResult, TgMessage, TgUpdate, TgUser } from './types.js';

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
   * `allowed_updates` is narrowed to messages — the bot has no callback
   * buttons, no inline mode and no reactions, so anything else is bandwidth
   * spent to be ignored.
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
        allowed_updates: ['message'],
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
    opts?: { disableNotification?: boolean; signal?: AbortSignal },
  ): Promise<TgCallResult<TgMessage>> {
    return this.call<TgMessage>(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        disable_notification: opts?.disableNotification ?? false,
      },
      { signal: opts?.signal },
    );
  }
}

/** Human-readable one-liner for a failed call, safe to log. */
export function describeCallError(method: string, result: TgCallResult<unknown>): string {
  const code = result.errorCode === 0 ? 'transport' : String(result.errorCode);
  return `${method} failed (${code}): ${result.description ?? 'no description'}`;
}
