import { resolveTargetMcapUsd } from '../../mcapCross/gates.js';
import { isMcapCrossEnabled } from '../../mcapCross/poller.js';
import { recentCrossings } from '../../mcapCross/state.js';
import { SPEC } from '../commandCatalog.js';
import { escapeHtml, joinLines } from '../html.js';
import { footer, renderRecentCrossings, type RecentCrossingView } from '../render.js';
import { PerChatRateLimiter } from '../sender.js';
import type { TgCommand } from './types.js';

/**
 * `/mcap` — the last few coins to cross the market-cap threshold.
 *
 * THE ONE COMMAND HERE THAT READS THE DATABASE ON DEMAND, so it is the one that
 * needed a budget before it needed features. Two things bound it, and both are
 * sized against the crossing poller's own cadence rather than against taste:
 *
 *   • A PROCESS-WIDE CACHE. The poller runs every three minutes and a token
 *     that fires is on a 24h cooldown, so the answer cannot change more often
 *     than that. One 90-second cache serves every chat on the instance, which
 *     means the worst case for the whole deployment is 40 reads an hour however
 *     many groups run the command. The result is global — an address, a chain,
 *     a number (see the migration: no user_id) — so sharing one copy across
 *     chats leaks nothing.
 *
 *   • A PER-CHAT LIMITER, because a cache miss is still a query and the point
 *     of a limiter is the case where the cache is cold. Three a minute is well
 *     above use and well below abuse.
 *
 * Both matter more than usual right now: production has been running its
 * Supabase connection pool near the limit, and a command any group member can
 * hold down is exactly the shape of thing that finishes it off.
 *
 * SELF-GATES ON THE POLLER. With the crossing feed switched off there is no
 * data and never will be on this instance, so the card says that rather than
 * rendering an empty list that looks like a quiet market.
 */

/** How long one fetch of the crossing list serves every chat. */
const CACHE_MS = 90_000;

/** Rows shown. Two lines each — more than this stops being scannable on a phone. */
const ROW_LIMIT = 5;

const limiter = new PerChatRateLimiter(60_000, 3);

let cache: { rows: RecentCrossingView[]; expiresAt: number } | null = null;

async function loadRows(now: number): Promise<RecentCrossingView[]> {
  if (cache && cache.expiresAt > now) return cache.rows;
  const rows = (await recentCrossings(ROW_LIMIT)).map(
    (row): RecentCrossingView => ({
      address: row.address,
      network: row.network,
      mcapUsd: row.lastSeenMcap,
      firedAt: row.firedAt,
    }),
  );
  cache = { rows, expiresAt: now + CACHE_MS };
  return rows;
}

/** Test seam: drop the shared cache. */
export function _resetMcapCommandCache(): void {
  cache = null;
}

export const mcap: TgCommand = {
  name: SPEC.mcap.name,
  description: SPEC.mcap.description,

  async execute(ctx) {
    const now = Date.now();

    if (!isMcapCrossEnabled()) {
      await ctx.reply(
        renderRecentCrossings([], { targetUsd: resolveTargetMcapUsd(), now, enabled: false }),
      );
      return;
    }

    // Checked after the cheap gate and before the read, so a chat over budget
    // costs nothing but the reply.
    if (!limiter.tryConsume(ctx.chatId, now)) {
      await ctx.reply(
        joinLines([escapeHtml('Asked a moment ago — try again in a minute.'), footer()]),
      );
      return;
    }

    // A failed read is an empty list inside the store (see recentCrossings), so
    // there is nothing to catch here; the card renders "nothing on record yet".
    await ctx.reply(
      renderRecentCrossings(await loadRows(now), {
        targetUsd: resolveTargetMcapUsd(),
        now,
        enabled: true,
      }),
    );
  },
};
