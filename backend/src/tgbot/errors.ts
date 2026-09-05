// Service-layer failures, described for a Telegram chat.
//
// bot/errors.ts already does this for Discord, but its strings carry Discord
// markdown (`**bold**`) and Discord-specific guidance ("link Discord on OCT"),
// both of which are wrong here — the asterisks would render literally and the
// advice names the wrong platform. The MAPPING is shared, the WORDING is not,
// so this mirrors the switch rather than importing the strings.
//
// Like its Discord twin it never leaks internals: an unrecognised error becomes
// a generic line and is logged server-side instead.

import { BotServiceError } from '../bot/service.js';

/**
 * A short, user-facing line for a failed command. Plain text — the caller
 * escapes it, so nothing here may contain markup.
 */
export function describeServiceError(err: unknown, action: string): string {
  if (err instanceof BotServiceError) {
    switch (err.code) {
      case 'not_configured':
        return '⚠️ That data source is not configured on this OCT instance yet.';
      case 'not_found':
        return `🔍 ${err.message}`;
      case 'not_linked':
        // Unreachable from the Telegram surface today (nothing here resolves an
        // OCT account), but the code exists, so it gets an honest answer.
        return '🔗 That lookup needs an OCT account linked to this chat.';
      case 'upstream':
        return '⚠️ The upstream data source is not responding right now. Try again in a minute.';
    }
  }
  console.error(`[TgBot] Failed to ${action}:`, (err as Error)?.message ?? err);
  return `❌ Could not ${action} right now.`;
}
