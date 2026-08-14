// Pure logic for FOMO new-join alerts.
//
// fomo.family's own social feed surfaces notable new accounts as feed items of
// type `user_with_smart_following` ("New traders" in the app's feed filter,
// rendered as "<name> just joined"). "Smart following" means accounts the
// platform considers notable followed the newcomer — which is exactly the
// signal the community asked for (the DraftKings-CEO join was one of these).
//
// Endpoint (verified against the site's own bundle, assets/authenticated-*.js):
//   GET /feed?limit=50&feedTypes=user_with_smart_following
//   → { success, responseObject: { feed: [ { id, type, createdAt,
//         body: { userId, userHandle, displayName, userImageUrl, followers } } ] } }
//
// This module is I/O-free: envelope extraction, normalization, cursor diffing,
// the notability gate and the burst cap all live here so they are unit-testable.
// The polling loop and all fan-out live in joinWatcher.ts.

/** Feed item type for "notable user just joined" (from the site's own bundle). */
export const JOIN_FEED_TYPE = 'user_with_smart_following';

export const JOIN_FEED_PATH = `/feed?limit=50&feedTypes=${JOIN_FEED_TYPE}`;

/** Max joins alerted per poll cycle; the rest collapse into "+N more". */
export const JOIN_ALERT_BURST_CAP = 5;

/** Bound on the persisted seen-user-id set (dedupe backstop behind the cursor). */
export const SEEN_USER_IDS_CAP = 500;

const DEFAULT_POLL_MS = 120_000;
/** Floor so a typo'd env can't turn this into a hot loop against fomo.family. */
const MIN_POLL_MS = 30_000;

/** `OCT_<name>` with the repo-standard `TRENCHCORD_<name>` fallback. */
function envVar(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return env[`OCT_${name}`] ?? env[`TRENCHCORD_${name}`];
}

/** Poll interval: OCT_FOMO_JOIN_POLL_MS (default 120000, floor 30000). */
export function resolveJoinPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(envVar('FOMO_JOIN_POLL_MS', env) ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_POLL_MS;
  return Math.max(raw, MIN_POLL_MS);
}

/** Notability floor: OCT_FOMO_JOIN_MIN_FOLLOWERS (default 0 = alert all). */
export function resolveJoinMinFollowers(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(envVar('FOMO_JOIN_MIN_FOLLOWERS', env) ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export interface JoinDiscordConfig {
  enabled: boolean;
  channelId: string | null;
}

/** Optional public Discord post — default OFF, needs both switch and channel. */
export function resolveJoinDiscordConfig(env: NodeJS.ProcessEnv = process.env): JoinDiscordConfig {
  const raw = envVar('FOMO_JOIN_DISCORD_ENABLED', env)?.trim().toLowerCase();
  return {
    enabled: raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on',
    channelId: envVar('FOMO_JOIN_DISCORD_CHANNEL_ID', env)?.trim() || null,
  };
}

/** One notable account that just joined fomo.family. */
export interface FomoJoinEvent {
  /** Feed item id — the pagination cursor unit, unique per feed entry. */
  feedId: string;
  fomoUserId: string;
  fomoHandle: string | null;
  displayName: string | null;
  imageUrl: string | null;
  /** How many "smart" accounts already follow them (size of body.followers). */
  smartFollowerCount: number;
  /**
   * fomo follower count, filled in by the optional batched /v2/users lookup
   * when the notability gate is active. null = unknown (gate fails open).
   */
  followerCount: number | null;
  /** ms epoch of the feed item, when parseable. */
  createdAt: number | null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Pull the feed array out of the `/feed` envelope. The site's bundle reads
 * `responseObject.feed`; the fallbacks cover the conventions seen elsewhere in
 * the FOMO API so a mild reshape degrades to "no items", never a throw.
 */
export function extractJoinFeedItems(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = (json as Record<string, unknown>).responseObject;
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.feed)) return o.feed;
    if (Array.isArray(o.items)) return o.items;
  }
  if (Array.isArray((json as Record<string, unknown>).feed)) {
    return (json as Record<string, unknown>).feed as unknown[];
  }
  return [];
}

/**
 * Normalize one raw feed item into a FomoJoinEvent, or null when it isn't a
 * join item (wrong type — we requested only joins, but never trust the filter)
 * or is missing the two fields dedupe and rendering both need.
 */
export function normalizeJoinItem(raw: unknown): FomoJoinEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  // Server-side feedTypes filtering should make this always true; drop anything
  // else defensively rather than alerting on trades or listings.
  if (typeof r.type === 'string' && r.type !== JOIN_FEED_TYPE) return null;

  const body = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, any>;
  const feedId = firstString(r.id, r.feedId, r.feed_id);
  const fomoUserId = firstString(body.userId, body.user_id, body.id);
  if (!feedId || !fomoUserId) return null;

  const followers = Array.isArray(body.followers) ? body.followers : [];
  const createdRaw = r.createdAt ?? r.created_at;
  let createdAt: number | null = null;
  if (typeof createdRaw === 'number' && Number.isFinite(createdRaw)) {
    createdAt = createdRaw;
  } else if (typeof createdRaw === 'string') {
    const parsed = Date.parse(createdRaw);
    createdAt = Number.isNaN(parsed) ? null : parsed;
  }

  return {
    feedId,
    fomoUserId,
    fomoHandle: firstString(body.userHandle, body.handle, body.username),
    displayName: firstString(body.displayName, body.name),
    imageUrl: firstString(body.userImageUrl, body.profilePictureLink, body.imageUrl),
    smartFollowerCount: followers.length,
    followerCount: null,
    createdAt,
  };
}

export interface JoinCursorState {
  lastFeedId: string | null;
  seenUserIds: string[];
}

export interface JoinDiff {
  /** New joins, oldest first (so fan-out lands newest-last, like the pollers). */
  fresh: FomoJoinEvent[];
  /** Feed id to persist as the new cursor (newest item seen this poll). */
  newestFeedId: string | null;
}

/**
 * Diff a newest-first feed page against the persisted cursor state.
 *
 * Two layers of dedupe, both restart-safe because both halves persist:
 *  - the feed-id cursor stops re-reading everything older than last poll;
 *  - the seen-user-id set stops a re-alert when the same user surfaces again
 *    under a new feed id (feed re-ranking, cursor write lost mid-crash).
 */
export function diffNewJoins(items: FomoJoinEvent[], state: JoinCursorState): JoinDiff {
  const newestFeedId = items.length > 0 ? items[0].feedId : null;
  const seen = new Set(state.seenUserIds);

  const fresh: FomoJoinEvent[] = [];
  const freshUserIds = new Set<string>();
  for (const item of items) {
    if (state.lastFeedId && item.feedId === state.lastFeedId) break;
    if (seen.has(item.fomoUserId) || freshUserIds.has(item.fomoUserId)) continue;
    freshUserIds.add(item.fomoUserId);
    fresh.push(item);
  }

  return { fresh: fresh.reverse(), newestFeedId };
}

/**
 * Notability gate. minFollowers <= 0 disables it (alert all). When active, an
 * UNKNOWN follower count passes — the feed is already curated to joins with
 * smart followers, so missing enrichment data must widen alerts, not eat them.
 */
export function passesNotability(event: FomoJoinEvent, minFollowers: number): boolean {
  if (minFollowers <= 0) return true;
  if (event.followerCount == null) return true;
  return event.followerCount >= minFollowers;
}

export interface JoinBurst {
  alert: FomoJoinEvent[];
  /** Joins beyond the cap this cycle — summarized as "+N more new joins". */
  suppressed: number;
}

/** Cap alerts per cycle; keep the NEWEST joins when over the cap. */
export function partitionJoinBurst(events: FomoJoinEvent[], cap: number = JOIN_ALERT_BURST_CAP): JoinBurst {
  if (events.length <= cap) return { alert: events, suppressed: 0 };
  return { alert: events.slice(events.length - cap), suppressed: events.length - cap };
}

/**
 * Fold this cycle's fresh user ids (alerted AND suppressed — a "+N more"
 * summary is that join's alert) into the persisted seen-set, newest last,
 * evicting from the front past the cap.
 */
export function mergeSeenUserIds(
  previous: string[],
  events: FomoJoinEvent[],
  cap: number = SEEN_USER_IDS_CAP,
): string[] {
  const merged = [...previous];
  const known = new Set(previous);
  for (const e of events) {
    if (known.has(e.fomoUserId)) continue;
    known.add(e.fomoUserId);
    merged.push(e.fomoUserId);
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** `DraftKings CEO` / `@handle` / the raw id — best display label we have. */
export function joinDisplayLabel(event: Pick<FomoJoinEvent, 'displayName' | 'fomoHandle' | 'fomoUserId'>): string {
  return event.displayName?.trim() || (event.fomoHandle ? `@${event.fomoHandle}` : event.fomoUserId);
}

/** Public profile URL (site route: fomo.family/profile/:handle). */
export function joinProfileUrl(event: Pick<FomoJoinEvent, 'fomoHandle'>): string | null {
  return event.fomoHandle ? `https://fomo.family/profile/${encodeURIComponent(event.fomoHandle)}` : null;
}

/** The `fomo_join` WS frame. Global signal: broadcast to every client. */
export function buildJoinPayload(event: FomoJoinEvent, suppressed: number): Record<string, unknown> {
  return {
    type: 'fomo_join',
    data: {
      feedId: event.feedId,
      fomoUserId: event.fomoUserId,
      fomoHandle: event.fomoHandle,
      displayName: event.displayName,
      imageUrl: event.imageUrl,
      smartFollowerCount: event.smartFollowerCount,
      followerCount: event.followerCount,
      profileUrl: joinProfileUrl(event),
      createdAt: event.createdAt,
      // Only ever non-zero on the LAST frame of a burst — the client renders it
      // as a "+N more new joins" suffix rather than N separate alerts.
      suppressed,
    },
  };
}

/** One Pushover message per user per cycle, however many joins the cycle had. */
export function buildJoinPushoverText(burst: JoinBurst): { title: string; message: string } {
  const names = burst.alert.map(joinDisplayLabel);
  const more = burst.suppressed > 0 ? ` +${burst.suppressed} more` : '';
  if (names.length === 1 && burst.suppressed === 0) {
    return {
      title: `FOMO: ${names[0]} just joined`,
      message: `${names[0]} just joined fomo.family — early = free entry.`,
    };
  }
  return {
    title: `FOMO: ${names.length + burst.suppressed} new notable joins`,
    message: `New on fomo.family: ${names.join(', ')}${more}.`,
  };
}
