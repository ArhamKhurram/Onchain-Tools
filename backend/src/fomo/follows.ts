// Best-effort follow sync for the shared FOMO service account.
//
// `/feed/tradingActivity` may be following-scoped (only trades from accounts the
// shared service account follows). When FOMO_ENSURE_FOLLOWS is not `false`, we
// attempt to follow each tracked user so their trades appear in the poll feed.
//
// The exact follow endpoint is not publicly documented; these are educated guesses
// verified against Outpost's fomo-test usage patterns. Failures are logged and
// never block tracking — the poller still runs for globally-visible trades.

import type { FomoClient } from './client.js';

function ensureFollowsEnabled(): boolean {
  return process.env.FOMO_ENSURE_FOLLOWS !== 'false';
}

function isFollowSuccess(status: number): boolean {
  // 2xx = followed; 409 / 400 often mean "already following".
  return (status >= 200 && status < 300) || status === 409 || status === 400;
}

/**
 * Make the shared FOMO account follow `fomoUserId` so its trades surface in
 * following-scoped feeds. No-op when FOMO_ENSURE_FOLLOWS=false.
 */
export async function ensureSharedAccountFollows(client: FomoClient, fomoUserId: string): Promise<void> {
  if (!ensureFollowsEnabled() || !fomoUserId) return;

  const encoded = encodeURIComponent(fomoUserId);

  // Primary guess: RESTful follow on the user resource.
  const primary = await client.call(`/v2/users/${encoded}/follow`, {
    method: 'POST',
    body: '{}',
  });
  if (isFollowSuccess(primary.status)) return;

  // Fallback: collection-style follow endpoint.
  const fallback = await client.call('/v2/follow', {
    method: 'POST',
    body: JSON.stringify({ userId: fomoUserId }),
  });
  if (isFollowSuccess(fallback.status)) return;

  console.warn(
    `[FOMO] Could not auto-follow ${fomoUserId} (status ${primary.status}/${fallback.status}). ` +
      'Trades may be missing if tradingActivity is following-scoped. Set FOMO_ENSURE_FOLLOWS=false to silence.',
  );
}

/** Follow every distinct FOMO user currently tracked by any OCT user. */
export async function syncAllTrackedFollows(
  client: FomoClient,
  fomoUserIds: Iterable<string>,
): Promise<void> {
  if (!ensureFollowsEnabled()) return;
  const seen = new Set<string>();
  for (const id of fomoUserIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      await ensureSharedAccountFollows(client, id);
    } catch (err) {
      console.warn('[FOMO] syncAllTrackedFollows failed for', id, ':', (err as Error)?.message);
    }
  }
}
