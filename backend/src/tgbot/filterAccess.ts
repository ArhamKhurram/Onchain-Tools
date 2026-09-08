// Reading and writing a bound account's market-cap filters, from the bot.
//
// WHY A MODULE AND NOT TWO CALLS. The panel and `/filters` both need the same
// three things — the account's stored overrides, what they resolve to, and what
// they would inherit — and both need the write to go through the same validated
// path the console's PUT uses. Two copies of that is two places for the bot and
// the console to start disagreeing about a threshold, which is the one outcome
// worse than having no bot controls at all.
//
// EGRESS. `getMcapCrossFilters` is a per-user row read, and the panel's Refresh
// is a button anybody in a group can hold down. So the resolved view is cached
// per ACCOUNT (not per chat — twenty chats on one instance default share one
// entry) for fifteen seconds, invalidated on every write, and the cache is the
// only thing between a press and storage. The baseline gate config is env, and
// costs nothing.
//
// THE STORAGE ABSTRACTION IS THE ONLY DOOR. Everything here goes through
// `getStorageProvider()`, so local mode writes the JSON config and hosted mode
// writes the user's settings row, exactly as the console's route does. There is
// no Supabase call in this file.

import {
  applyFilterPatch,
  resolveUserGateConfig,
  sanitizeStoredFilters,
  validateFilterPatch,
  type McapCrossFilterKey,
  type McapCrossFilters,
} from '../mcapCross/filters.js';
import { resolveGateConfig } from '../mcapCross/gates.js';
import { getStorageProvider } from '../storage/index.js';
import { filterLines, type FilterLine } from './filtersView.js';

/** How long one account's resolved filters are reused across presses. */
const CACHE_MS = 15_000;

/** Beyond this many cached accounts the map is swept. */
const PRUNE_AT = 200;

export interface AccountFilterView {
  stored: McapCrossFilters;
  lines: FilterLine[];
  overrideCount: number;
}

interface CacheEntry {
  view: AccountFilterView | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function build(stored: McapCrossFilters): AccountFilterView {
  const defaults = resolveGateConfig();
  const effective = resolveUserGateConfig(stored, defaults);
  return {
    stored,
    lines: filterLines(
      stored,
      effective as unknown as Record<string, unknown>,
      defaults as unknown as Record<string, unknown>,
    ),
    overrideCount: Object.keys(stored).length,
  };
}

function prune(now: number): void {
  if (cache.size <= PRUNE_AT) return;
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
}

/**
 * One account's filters as the bot renders them, or null when storage could
 * not answer.
 *
 * A FAILED READ IS CACHED AS NULL for the same reason the panel caches a failed
 * roster read: retrying on every press would add load to the thing that is
 * already down. The card says "unavailable" rather than showing a plausible
 * default, so nobody acts on a threshold that is not really theirs.
 */
export async function readAccountFilters(
  userId: string,
  now: number = Date.now(),
  fresh = false,
): Promise<AccountFilterView | null> {
  if (!fresh) {
    const cached = cache.get(userId);
    if (cached && cached.expiresAt > now) return cached.view;
  }

  let view: AccountFilterView | null = null;
  try {
    view = build(sanitizeStoredFilters(await getStorageProvider().getMcapCrossFilters(userId)));
  } catch (err) {
    console.error('[TgBot] Could not read alert filters:', (err as Error)?.message ?? err);
  }
  cache.set(userId, { view, expiresAt: now + CACHE_MS });
  prune(now);
  return view;
}

export type FilterWriteResult =
  | { ok: true; view: AccountFilterView }
  | { ok: false; errors: string[] };

/**
 * Store one threshold, or clear it back to inherited.
 *
 * THE VALIDATOR RUNS HERE TOO, not only at the parse. The caller has already
 * been through `parseFilterValue`, but this is the function that touches
 * storage and it must be safe to call from anywhere — so it re-asks
 * `validateFilterPatch`, and `applyFilterPatch` performs the merge, both of
 * them the same functions `PUT /api/mcap-cross/filters` calls. A value the
 * console would reject cannot be written by the bot, by construction rather
 * than by both surfaces remembering the same rule.
 */
export async function writeAccountFilter(
  userId: string,
  key: McapCrossFilterKey,
  value: number | null,
  now: number = Date.now(),
): Promise<FilterWriteResult> {
  const patch: Record<string, unknown> = { [key]: value };
  const parsed = validateFilterPatch(patch);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  try {
    const storage = getStorageProvider();
    const stored = sanitizeStoredFilters(await storage.getMcapCrossFilters(userId));
    const next = applyFilterPatch(stored, patch, parsed.value);
    const saved = await storage.setMcapCrossFilters(userId, next);
    const view = build(sanitizeStoredFilters(saved));
    cache.set(userId, { view, expiresAt: now + CACHE_MS });
    return { ok: true, view };
  } catch (err) {
    console.error('[TgBot] Could not save an alert filter:', (err as Error)?.message ?? err);
    cache.delete(userId);
    return { ok: false, errors: ['OCT storage is unavailable — nothing was changed.'] };
  }
}

/** Clear every override for one account. The bot's twin of the console's DELETE. */
export async function resetAccountFilters(
  userId: string,
  now: number = Date.now(),
): Promise<FilterWriteResult> {
  try {
    const saved = await getStorageProvider().setMcapCrossFilters(userId, {});
    const view = build(sanitizeStoredFilters(saved));
    cache.set(userId, { view, expiresAt: now + CACHE_MS });
    return { ok: true, view };
  } catch (err) {
    console.error('[TgBot] Could not reset alert filters:', (err as Error)?.message ?? err);
    cache.delete(userId);
    return { ok: false, errors: ['OCT storage is unavailable — nothing was changed.'] };
  }
}

/** Test seam, and the escape hatch after an out-of-band change. */
export function resetFilterCache(): void {
  cache.clear();
}
