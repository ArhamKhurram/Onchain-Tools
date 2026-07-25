import { BotServiceError } from './service.js';

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
      case 'upstream':
        return '⚠️ FOMO is not responding right now. Try again in a minute.';
    }
  }
  console.error(`[Bot] Failed to ${action}:`, (err as Error)?.message ?? err);
  return `❌ Could not ${action} right now.`;
}
