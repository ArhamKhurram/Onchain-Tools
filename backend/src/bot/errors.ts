import { BotServiceError } from './service.js';
import { isHostedMode } from '../storage/index.js';

/** HTTP status for a service-layer failure. Shared by the bot API and the console API. */
export function statusForServiceError(err: BotServiceError): number {
  switch (err.code) {
    case 'not_configured': return 503;
    case 'not_found': return 404;
    case 'not_linked': return 403;
    case 'upstream': return 502;
  }
}

/**
 * Write a service-layer failure to an Express response. In hosted mode unknown
 * errors collapse to `fallback` and are logged server-side instead, matching
 * safeError in fomo/routes.ts.
 */
export function sendServiceError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  err: unknown,
  fallback: string,
): void {
  if (err instanceof BotServiceError) {
    res.status(statusForServiceError(err)).json({ error: err.message });
    return;
  }
  if (!isHostedMode()) {
    res.status(500).json({ error: (err as Error)?.message ?? fallback });
    return;
  }
  console.error(`[API] ${fallback}:`, (err as Error)?.message ?? err);
  res.status(500).json({ error: fallback });
}

/**
 * Turn a service-layer failure into a short, user-facing line for an embed.
 * Never leaks internals: unknown errors collapse to a generic message and are
 * logged server-side instead.
 */
export function describeServiceError(err: unknown, action: string): string {
  if (err instanceof BotServiceError) {
    switch (err.code) {
      case 'not_configured':
        return '⚠️ FOMO data is not configured on this OCT instance yet.';
      case 'not_found':
        return `🔍 ${err.message}`;
      case 'not_linked':
        // Gatekeep for accounts with no Discord identity on OCT (email/Google
        // sign-ups). They can link Discord to their existing OCT account.
        return [
          '🔗 **This Discord account isn\'t linked to an OCT account.**',
          'Sign in to OCT with Discord (or link Discord to your existing account) and run this again.',
        ].join('\n');
      case 'upstream':
        return '⚠️ FOMO is not responding right now. Try again in a minute.';
    }
  }
  console.error(`[Bot] Failed to ${action}:`, (err as Error)?.message ?? err);
  return `❌ Could not ${action} right now.`;
}
