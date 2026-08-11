// FOMO new-join watcher.
//
// Polls fomo.family's own social feed for `user_with_smart_following` items —
// notable accounts that just joined — and raises a global `fomo_join` signal:
// a WS broadcast to every connected client, an opt-in Pushover push to FOMO
// subscribers, and (env-gated OFF) one card in a public Discord channel.
//
// A notable person JOINING is the trade signal: early awareness = free entry
// ("DraftKings CEO joining was kinda free yesterday"). This stays its own
// signal — never fused with trades, convergence, revival or missed-runner.
//
// Budget: ONE feed request per cycle (default 120s), plus at most one batched
// /v2/users lookup when the follower-count gate is active. Per-trader poll
// volume is untouched.
//
// Cursor state persists in fomo_join_poll_state through the shared FOMO
// service client — the same storage layer the trade poller's activity cursors
// use (fomo_* tables sit deliberately outside StorageProvider; see
// fomo/store.ts). `seeded` guards cold start: the first poll records the
// newest feed id and fires nothing, so a backlog is never pinged.

import { MessageFlags } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WsServer } from '../ws/server.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import { getBotClient } from '../bot/index.js';
import { BRAND, botFooter, makeContainer, makeSection, makeSeparator, makeText, makeThumbnail } from '../bot/layout.js';
import { ensureSharedFomoClientReady } from './client.js';
import type { FomoClientLike } from './types.js';
import { getFomoServiceClient } from './store.js';
import {
  JOIN_FEED_PATH,
  buildJoinPayload,
  buildJoinPushoverText,
  diffNewJoins,
  extractJoinFeedItems,
  joinDisplayLabel,
  joinProfileUrl,
  mergeSeenUserIds,
  normalizeJoinItem,
  partitionJoinBurst,
  passesNotability,
  resolveJoinDiscordConfig,
  resolveJoinMinFollowers,
  resolveJoinPollIntervalMs,
  type FomoJoinEvent,
  type JoinBurst,
  type JoinCursorState,
} from './joinFeed.js';

const DEBUG = process.env.DEBUG === 'true';

// --- Cursor persistence (fomo_join_poll_state, single row) ------------------

interface PersistedJoinState extends JoinCursorState {
  seeded: boolean;
}

async function getJoinPollState(db: SupabaseClient): Promise<PersistedJoinState | null> {
  const { data, error } = await db
    .from('fomo_join_poll_state')
    .select('last_feed_id, seeded, seen_user_ids')
    .eq('id', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { last_feed_id: string | null; seeded: boolean | null; seen_user_ids: unknown };
  return {
    lastFeedId: row.last_feed_id,
    seeded: row.seeded ?? false,
    seenUserIds: Array.isArray(row.seen_user_ids)
      ? (row.seen_user_ids as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
  };
}

async function setJoinPollState(
  db: SupabaseClient,
  lastFeedId: string | null,
  seeded: boolean,
  seenUserIds: string[],
): Promise<void> {
  const { error } = await db.from('fomo_join_poll_state').upsert(
    {
      id: true,
      last_feed_id: lastFeedId,
      seeded,
      seen_user_ids: seenUserIds,
      last_polled_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw error;
}

/**
 * Pushover audience: OCT users who track at least one FOMO trader with
 * notifications on. Joins have no per-user subscription of their own, so the
 * FOMO-notify opt-in is the consent signal — never every user in the system.
 */
async function loadJoinPushoverUserIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from('fomo_tracked_users')
    .select('user_id')
    .eq('notify_pushover', true);
  if (error) throw error;
  const ids = new Set<string>();
  for (const row of data ?? []) {
    if (row.user_id) ids.add(row.user_id);
  }
  return [...ids];
}

// --- Follower-count enrichment (optional 2nd request) -----------------------

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * One batched `/v2/users?userIds=a&userIds=b` call (the shape the site's own
 * search uses) filling in follower counts for the notability gate. Best-effort:
 * any failure leaves counts null and the gate fails open.
 */
async function enrichFollowerCounts(client: FomoClientLike, events: FomoJoinEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const query = events.map((e) => `userIds=${encodeURIComponent(e.fomoUserId)}`).join('&');
    const res = await client.call(`/v2/users?${query}`);
    if (!res.status || res.status < 200 || res.status >= 300) return;
    const json = res.json as { responseObject?: { users?: unknown[] } } | null;
    const users = Array.isArray(json?.responseObject?.users) ? json.responseObject.users : [];
    const byId = new Map<string, Record<string, any>>();
    for (const u of users) {
      if (!u || typeof u !== 'object') continue;
      const user = u as Record<string, any>;
      const id = typeof user.id === 'string' ? user.id : typeof user.userId === 'string' ? user.userId : null;
      if (id) byId.set(id, user);
    }
    for (const e of events) {
      const user = byId.get(e.fomoUserId);
      if (!user) continue;
      e.followerCount = firstFiniteNumber(user.twitterFollowers, user.twitter_followers, user.followers);
      if (!e.imageUrl) {
        e.imageUrl = typeof user.profilePictureLink === 'string' ? user.profilePictureLink : e.imageUrl;
      }
    }
  } catch (err) {
    console.warn('[FomoJoinWatcher] follower-count enrichment failed (gate fails open):', (err as Error)?.message);
  }
}

// --- Optional public Discord post (default OFF) -----------------------------

async function postJoinsToDiscord(burst: JoinBurst): Promise<void> {
  try {
    const config = resolveJoinDiscordConfig();
    if (!config.enabled || !config.channelId) return;
    const client = getBotClient();
    if (!client) return;

    const channel = await client.channels.fetch(config.channelId);
    if (!channel || !('send' in channel)) {
      console.warn(`[FomoJoinWatcher] Discord channel ${config.channelId} is missing or not postable.`);
      return;
    }

    for (let i = 0; i < burst.alert.length; i++) {
      const event = burst.alert[i];
      const isLast = i === burst.alert.length - 1;
      const name = joinDisplayLabel(event);
      const handle = event.fomoHandle ? `@${event.fomoHandle}` : event.fomoUserId;
      const profile = joinProfileUrl(event);

      const meta: string[] = [handle];
      if (event.smartFollowerCount > 0) meta.push(`${event.smartFollowerCount} smart follower(s) already`);
      if (event.followerCount != null) meta.push(`${event.followerCount.toLocaleString()} followers`);

      const headline = [makeText(`# 🆕 ${name} just joined fomo`), makeText(`-# ${meta.join(' · ')}`)];
      const header = event.imageUrl ? [makeSection(headline, makeThumbnail(event.imageUrl))] : headline;

      const note = isLast && burst.suppressed > 0
        ? [makeText(`-# +${burst.suppressed} more new join(s) this cycle`)]
        : [];

      await (channel as { send: (payload: unknown) => Promise<unknown> }).send({
        flags: MessageFlags.IsComponentsV2,
        components: [
          makeContainer(BRAND.gold, [
            ...header,
            makeSeparator(1),
            ...(profile ? [makeText(`[Profile →](${profile})`)] : []),
            ...note,
            makeText(botFooter('fomo.family new join')),
          ]),
        ],
      });
    }
  } catch (err) {
    console.warn('[FomoJoinWatcher] Discord post failed:', (err as Error)?.message);
  }
}

// --- Watcher ----------------------------------------------------------------

class FomoJoinWatcher {
  private wsServer: WsServer;
  private client: FomoClientLike | null = null;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  private pollIntervalMs = resolveJoinPollIntervalMs();

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // Same self-gate as the trade poller: no Supabase → idle (local mode boots
    // clean without FOMO); no shared refresh token → idle.
    const db = getFomoServiceClient();
    if (!db) {
      console.log('[FomoJoinWatcher] Supabase not configured; join watcher idle.');
      return;
    }
    this.db = db;
    void this.bootstrap();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async bootstrap(): Promise<void> {
    try {
      const client = await ensureSharedFomoClientReady();
      if (!client) {
        console.log('[FomoJoinWatcher] No FOMO refresh token in DB or env; join watcher idle.');
        return;
      }
      this.client = client;
      console.log(`[FomoJoinWatcher] Started (interval ${this.pollIntervalMs}ms).`);
      void this.poll().catch((err) => console.error('[FomoJoinWatcher] initial poll error:', (err as Error)?.message));
      this.scheduleNext();
    } catch (err) {
      console.error('[FomoJoinWatcher] Failed to start:', (err as Error)?.message);
    }
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.poll()
        .catch((err) => console.error('[FomoJoinWatcher] poll error:', (err as Error)?.message))
        .finally(() => this.scheduleNext());
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.client || !this.db) return;
    this.polling = true;
    try {
      // Request 1 of ≤2: the joins feed itself.
      const res = await this.client.call(JOIN_FEED_PATH);
      if (!res.status || res.status < 200 || res.status >= 300) {
        throw new Error(`joins feed upstream ${res.status ?? 0}: ${res.text?.slice?.(0, 200) ?? ''}`);
      }

      const items = extractJoinFeedItems(res.json)
        .map(normalizeJoinItem)
        .filter((e): e is FomoJoinEvent => e !== null);

      if (DEBUG && items.length > 0) {
        console.log(`[FomoJoinWatcher] Feed returned ${items.length} join item(s); newest ${items[0].feedId}.`);
      }

      const state = await getJoinPollState(this.db);

      // First run (unseeded): seed the cursor, fire nothing — never ping a
      // cold-start backlog (same rule as the callout poller).
      if (!state?.seeded) {
        await setJoinPollState(
          this.db,
          items.length > 0 ? items[0].feedId : null,
          true,
          mergeSeenUserIds([], items),
        );
        console.log(`[FomoJoinWatcher] Seeded join cursor (${items.length} existing item(s) recorded, none alerted).`);
        return;
      }

      const { fresh, newestFeedId } = diffNewJoins(items, state);
      if (fresh.length === 0) {
        if (newestFeedId && newestFeedId !== state.lastFeedId) {
          await setJoinPollState(this.db, newestFeedId, true, state.seenUserIds);
        }
        return;
      }

      // Request 2 of ≤2 (only when the gate is active): follower counts.
      const minFollowers = resolveJoinMinFollowers();
      if (minFollowers > 0) {
        await enrichFollowerCounts(this.client, fresh);
      }
      const notable = fresh.filter((e) => passesNotability(e, minFollowers));

      const burst = partitionJoinBurst(notable);
      if (burst.alert.length > 0) {
        this.dispatchWs(burst);
        await this.dispatchPushover(burst);
        // Public channel post LAST so it can never delay or break WS/Pushover.
        await postJoinsToDiscord(burst);
        console.log(
          `[FomoJoinWatcher] Alerted ${burst.alert.length} new join(s)` +
            `${burst.suppressed > 0 ? ` (+${burst.suppressed} suppressed by burst cap)` : ''}: ` +
            burst.alert.map(joinDisplayLabel).join(', '),
        );
      }

      // Persist AFTER fan-out: a crash mid-fan-out re-alerts (rare, tolerable);
      // the reverse silently drops joins (never acceptable for this signal).
      await setJoinPollState(
        this.db,
        newestFeedId ?? state.lastFeedId,
        true,
        mergeSeenUserIds(state.seenUserIds, fresh),
      );
    } finally {
      this.polling = false;
    }
  }

  /** Global broadcast — a join is not scoped to any tracked-trader subscriber. */
  private dispatchWs(burst: JoinBurst): void {
    for (let i = 0; i < burst.alert.length; i++) {
      const isLast = i === burst.alert.length - 1;
      this.wsServer.broadcastRaw(buildJoinPayload(burst.alert[i], isLast ? burst.suppressed : 0));
    }
  }

  /** One Pushover push per opted-in user per cycle, normal priority. */
  private async dispatchPushover(burst: JoinBurst): Promise<void> {
    if (!this.db) return;
    let userIds: string[];
    try {
      userIds = await loadJoinPushoverUserIds(this.db);
    } catch (err) {
      console.warn('[FomoJoinWatcher] Could not load Pushover audience:', (err as Error)?.message);
      return;
    }

    const { title, message } = buildJoinPushoverText(burst);
    const url = joinProfileUrl(burst.alert[burst.alert.length - 1]) ?? undefined;

    for (const userId of userIds) {
      try {
        const config = await getStorageProvider().getConfig(userId);
        if (!config.pushover?.enabled) continue;
        // Normal priority on purpose: the emergency repeat tier is reserved for
        // revival alerts. sendPushover inherits the user's configured priority.
        await sendPushover(config.pushover, { title, message, url, urlTitle: 'Open profile' });
      } catch (err) {
        console.error('[FomoJoinWatcher] Pushover notify failed:', (err as Error)?.message);
      }
    }
  }
}

let _watcher: FomoJoinWatcher | null = null;

export function startFomoJoinWatcher(wsServer: WsServer): void {
  if (_watcher) return;
  _watcher = new FomoJoinWatcher(wsServer);
  _watcher.start();
}
