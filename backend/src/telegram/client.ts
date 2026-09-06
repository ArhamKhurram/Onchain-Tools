import { EventEmitter } from 'events';
import { TelegramClient as GramJSClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { NewMessage } from 'teleproto/events/index.js';
import { EditedMessage } from 'teleproto/events/EditedMessage.js';
import { Api } from 'teleproto/tl/index.js';
import type { TelegramChat, TelegramSender, TelegramRawMessage, TelegramMedia, TelegramButton, TelegramForumTopic } from './types.js';
import { rewriteReferralLinks } from '../utils/contract.js';

/**
 * The forum-topic id of a message, or null if it is not in a topic.
 *
 * Telegram encodes topic membership in the reply header: a forum message carries ``forumTopic``,
 * and the topic root is ``replyToTopId`` when the message is a reply *within* the topic, or
 * ``replyToMsgId`` when it is a top-level post in the topic (the message that opened the topic is
 * the root). Non-forum groups and the "General" topic carry no ``forumTopic`` flag → null, which
 * keeps them flat (scoped to the group) exactly as before topics existed.
 *
 * Pure and exported so the mapping is unit-tested without a live MTProto session.
 */
export function extractTopicId(replyTo: Api.Message['replyTo']): number | null {
  if (replyTo && 'forumTopic' in replyTo && replyTo.forumTopic) {
    return replyTo.replyToTopId ?? replyTo.replyToMsgId ?? null;
  }
  return null;
}

/**
 * Split a room's channel id back into the chat and, if present, the forum topic.
 *
 * Rooms address a forum topic as ``chatId:topicId`` (telegramChannelId in
 * telegram/messageProcessor.ts). MTProto has no such addressing — getEntity
 * takes the chat and the topic is a `replyTo` thread id — so every read path
 * that accepts a room channel id has to undo the join first. A chat id is
 * ``-100…``, so the leading minus is never a separator; only a colon is.
 *
 * Pure and exported so the round trip is unit-tested without a live session.
 */
export function splitTopicChannelId(channelId: string): { chatId: string; topicId: number | null } {
  const idx = channelId.indexOf(':');
  if (idx === -1) return { chatId: channelId, topicId: null };
  const topic = Number(channelId.slice(idx + 1));
  if (!Number.isInteger(topic) || topic <= 0) return { chatId: channelId.slice(0, idx), topicId: null };
  return { chatId: channelId.slice(0, idx), topicId: topic };
}

/**
 * Whether ``replyTo`` points at a genuine replied-to message versus a forum topic root.
 *
 * In a forum, a top-level topic post carries ``forumTopic`` + ``replyToMsgId`` (the topic root)
 * but no ``replyToTopId`` — that is NOT a reply, and rendering it as one shows a spurious
 * "replying to …" against the topic-creation message. A real reply inside a topic additionally
 * carries ``replyToTopId``. Outside forums, any ``replyToMsgId`` is a genuine reply.
 */
export function isGenuineReply(replyTo: Api.Message['replyTo']): boolean {
  if (!replyTo || !('replyToMsgId' in replyTo) || !replyTo.replyToMsgId) return false;
  if ('forumTopic' in replyTo && replyTo.forumTopic && !replyTo.replyToTopId) return false;
  return true;
}

/** How often to prove the update stream is still alive. */
const HEALTH_CHECK_INTERVAL_MS = 60_000;
/** A health check that hangs this long counts as a dead connection. */
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;

/** How long a resolved reply snippet stays served from cache (it is a cosmetic preview). */
const REPLY_CACHE_TTL_MS = 5 * 60_000;
/** Failed lookups (deleted messages, transient errors) are negative-cached briefly. */
const REPLY_CACHE_MISS_TTL_MS = 60_000;
const REPLY_CACHE_MAX = 1_000;

/**
 * How long a failed chat/sender getEntity is remembered before retrying. Failures
 * (missing access hash, restricted entity) used to retry on EVERY message from
 * that chat or sender — one network attempt per message, indefinitely. Kept short
 * so an entity that becomes resolvable (e.g. after getDialogs primes the session
 * cache) recovers quickly.
 */
const ENTITY_FAILURE_TTL_MS = 60_000;
const ENTITY_FAILURE_MAX = 500;

export class TelegramClientWrapper extends EventEmitter {
  private client: GramJSClient;
  private session: StringSession;
  private apiId: number;
  private apiHash: string;
  private chatCache = new Map<string, TelegramChat>();
  private senderCache = new Map<string, TelegramSender>();
  /** `chatId:topicId` -> topic title, filled by getForumTopics (and lazily on first sight). */
  private topicTitles = new Map<string, string>();
  /** Chats with a topic-title fetch already in flight, so one unknown topic = one fetch. */
  private topicFetchInFlight = new Set<string>();
  /**
   * `chatId:msgId` -> resolved reply snippet (null = known-missing). Trench chats pile
   * dozens of replies onto the same root message, and without this every one of them
   * cost a getMessages round-trip re-fetching that same root.
   */
  private replyCache = new Map<string, { value: TelegramRawMessage['replyTo']; ts: number; ttl: number }>();
  /** `chat:<id>` / `sender:<id>` -> when the last getEntity for it failed. */
  private entityFailures = new Map<string, number>();
  private connected = false;
  private handlersWired = false;
  private disposed = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnecting = false;

  constructor(apiId: number, apiHash: string, sessionString: string) {
    super();
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.session = new StringSession(sessionString);
    this.client = new GramJSClient(this.session, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      this.connected = true;
      this.reconnectAttempts = 0;

      const me = await this.client.getMe() as Api.User;
      console.log(`[Telegram] Connected as ${me.firstName} (@${me.username ?? 'no-username'})`);

      this.emit('ready', {
        id: me.id.toString(),
        username: me.username ?? null,
        firstName: me.firstName ?? '',
      });

      this.setupEventHandlers();
      this.startHealthCheck();
      // Prime the entity/chat cache once so resolveChat's getEntity can resolve
      // channels. teleproto's UpdateManager keeps the update stream live on its
      // own, so no recurring polling is needed.
      await this.client.getDialogs({ limit: 200 }).catch(() => {});
    } catch (err: any) {
      console.error('[Telegram] Connection failed:', err.message);
      this.connected = false;
      // teleproto gives up after its own retries, and a laptop sleep or a
      // network blip can kill the socket without any error surfacing. Keep
      // trying in the background instead of going quiet until a restart.
      this.scheduleReconnect();
      this.emit('fatal', new Error(`Telegram connection failed: ${err.message}`));
    }
  }

  /**
   * teleproto can drop the update stream silently — the socket looks fine, the
   * client reports connected, and messages simply stop arriving. Poll a cheap
   * authenticated call so a dead connection is detected and rebuilt.
   */
  private startHealthCheck(): void {
    if (this.healthTimer || this.disposed) return;
    this.healthTimer = setInterval(() => {
      void this.runHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  private async runHealthCheck(): Promise<void> {
    if (this.disposed || this.reconnecting || !this.connected) return;
    try {
      await Promise.race([
        this.client.invoke(new Api.updates.GetState()),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('health check timed out')), HEALTH_CHECK_TIMEOUT_MS),
        ),
      ]);
    } catch (err: any) {
      console.warn(`[Telegram] Health check failed (${err.message}); reconnecting.`);
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.reconnecting) return;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.client.disconnect().catch(() => {});
      await this.client.connect();
      const me = await this.client.getMe() as Api.User;
      this.connected = true;
      this.reconnectAttempts = 0;
      // Handlers live on the client instance, which we reuse, so setupEventHandlers
      // no-ops here rather than duplicating every message.
      this.setupEventHandlers();
      this.startHealthCheck();
      console.log(`[Telegram] Reconnected as ${me.firstName} (@${me.username ?? 'no-username'})`);
      this.emit('ready', {
        id: me.id.toString(),
        username: me.username ?? null,
        firstName: me.firstName ?? '',
      });
    } catch (err: any) {
      console.error('[Telegram] Reconnect failed:', err.message);
      this.connected = false;
      this.scheduleReconnect();
    } finally {
      this.reconnecting = false;
    }
  }

  private setupEventHandlers(): void {
    if (this.handlersWired) return;
    this.handlersWired = true;

    this.client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        const raw = await this.buildRawMessage(message);
        if (raw) {
          this.emit('message', raw);
        }
      } catch (err: any) {
        console.error('[Telegram] Error processing message:', err.message);
      }
    }, new NewMessage({}));

    this.client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        // Edits only propagate {messageId, channelId, content} downstream, and
        // bot channels edit stat messages continuously — skip the reply/forward
        // context fetches (one MTProto round-trip each) that would be discarded.
        const raw = await this.buildRawMessage(message, { skipContext: true });
        if (raw) {
          this.emit('messageUpdate', raw);
        }
      } catch (err: any) {
        console.error('[Telegram] Error processing message update:', err.message);
      }
    }, new EditedMessage({}));
  }

  /**
   * ``skipContext`` (the edit path) elides the reply and forward *network* resolution:
   * the replied-to message fetch (one getMessages round-trip per event) and the
   * forward-source getEntity. Everything the update consumer reads — chat, topic,
   * sender, text — still resolves exactly as before, from caches.
   */
  private async buildRawMessage(
    message: Api.Message,
    opts?: { skipContext?: boolean },
  ): Promise<TelegramRawMessage | null> {
    const chat = await this.resolveChat(message);
    if (!chat) return null;

    const sender = await this.resolveSender(message);
    if (!sender) return null;

    const rawReplyTo = message.replyTo;
    let replyTo: TelegramRawMessage['replyTo'] = null;
    if (!opts?.skipContext && rawReplyTo && isGenuineReply(rawReplyTo) && 'replyToMsgId' in rawReplyTo && rawReplyTo.replyToMsgId) {
      const replyMsgId = rawReplyTo.replyToMsgId;
      const cacheKey = `${chat.id}:${replyMsgId}`;
      const cached = this.replyCacheGet(cacheKey);
      if (cached !== undefined) {
        replyTo = cached;
      } else {
        try {
          const replyMsg = await this.client.getMessages(message.peerId!, {
            ids: [replyMsgId],
          });
          if (replyMsg.length > 0 && replyMsg[0]) {
            const replySender = await this.resolveSender(replyMsg[0]);
            replyTo = {
              id: replyMsg[0].id,
              senderName: replySender?.firstName ?? 'Unknown',
              text: replyMsg[0].text ?? '',
            };
          }
        } catch {
          // Reply resolution can fail for deleted messages
        }
        this.replyCacheSet(cacheKey, replyTo);
      }
    }

    let forward: TelegramRawMessage['forward'] = null;
    if (message.fwdFrom) {
      const fwd = message.fwdFrom;
      let senderName = 'Unknown';
      let chatTitle: string | undefined;
      if (opts?.skipContext) {
        senderName = fwd.fromName ?? 'Unknown';
      } else if (fwd.fromId) {
        try {
          const entity = await this.client.getEntity(fwd.fromId);
          if (entity instanceof Api.User) {
            senderName = entity.firstName ?? entity.username ?? 'Unknown';
          } else if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
            senderName = (entity as any).title ?? 'Unknown';
            chatTitle = (entity as any).title;
          }
        } catch {
          senderName = fwd.fromName ?? 'Unknown';
        }
      } else if (fwd.fromName) {
        senderName = fwd.fromName;
      }
      forward = { senderName, chatTitle };
    }

    const media = await this.resolveMedia(message);
    if (media) {
      media.url = `/api/telegram/media/${chat.id}/${message.id}`;
    }
    const sticker = await this.resolveSticker(message);
    const poll = this.resolvePoll(message);
    const buttons = this.resolveButtons(message);
    const topicId = extractTopicId(message.replyTo);

    return {
      id: message.id,
      chatId: chat.id,
      chatTitle: chat.title,
      chatType: chat.type,
      chatUsername: chat.username ?? null,
      chatInviteLink: chat.inviteLink ?? null,
      // Topic scoping. The id is what routing and per-topic subscriptions key on; the title is
      // cosmetic, served from the topic-title cache and lazily refreshed in the background —
      // an unknown topic renders as "Topic <id>" until the fetch lands, never blocks ingestion.
      topicId,
      topicTitle: this.topicTitleFor(chat.id, topicId),
      sender,
      text: this.applyLinkEntities(message),
      date: message.date,
      replyTo,
      forward,
      media,
      sticker,
      poll,
      buttons,
    };
  }

  // Build the message display text as markdown from the RAW text plus its
  // formatting entities. Important: we must use message.rawText here, not
  // message.text — teleproto derives message.text by re-serializing the raw
  // text through the client parse mode, which injects markdown characters and
  // shifts every position, so it no longer lines up with the entity offsets
  // (which are relative to the raw text). Entity offsets are UTF-16 units,
  // matching JS string indexing.
  //
  // We serialize bold/code/links ourselves so their offsets stay consistent.
  // Links whose visible label is just numbers/symbols (stat-value noise) are
  // dropped to plain text; everything else stays a clickable link.
  private applyLinkEntities(message: Api.Message): string {
    const raw = message.rawText ?? '';
    const entities = message.entities;
    if (!entities || entities.length === 0) return raw;

    const isMeaningfulLabel = (s: string) => /[\p{L}\p{Extended_Pictographic}]/u.test(s);

    // Markers to splice into the raw text. `rank` controls nesting so bold wraps
    // links (e.g. "**[label](url)**"): lower rank is more outer.
    type Marker = { pos: number; kind: 0 | 1; rank: number; str: string; offset: number; length: number };
    const markers: Marker[] = [];
    const add = (offset: number, length: number, rank: number, open: string, close: string) => {
      markers.push({ pos: offset, kind: 1, rank, str: open, offset, length });
      markers.push({ pos: offset + length, kind: 0, rank, str: close, offset, length });
    };

    for (const e of entities) {
      if (e instanceof Api.MessageEntityBold) {
        add(e.offset, e.length, 0, '**', '**');
      } else if (e instanceof Api.MessageEntityCode) {
        add(e.offset, e.length, 1, '`', '`');
      } else if (e instanceof Api.MessageEntityPre) {
        add(e.offset, e.length, 1, '```\n', '\n```');
      } else if (e instanceof Api.MessageEntityTextUrl) {
        const label = raw.substring(e.offset, e.offset + e.length);
        if (!isMeaningfulLabel(label)) continue;
        add(e.offset, e.length, 2, '[', `](${rewriteReferralLinks(e.url)})`);
      }
    }
    if (markers.length === 0) return raw;

    markers.sort((a, b) => {
      if (a.pos !== b.pos) return a.pos - b.pos;
      if (a.kind !== b.kind) return a.kind - b.kind; // closes before opens
      if (a.kind === 1) return a.rank - b.rank || b.length - a.length; // opens: outer first
      return b.rank - a.rank || b.offset - a.offset; // closes: inner first
    });

    let result = '';
    let cursor = 0;
    for (const m of markers) {
      result += raw.substring(cursor, m.pos);
      result += m.str;
      cursor = m.pos;
    }
    result += raw.substring(cursor);
    return result;
  }

  // Inline keyboard URL buttons (e.g. "dash", "chart") carry links that aren't
  // part of the message text. Extract the ones that resolve to an actual URL.
  private resolveButtons(message: Api.Message): TelegramButton[] | null {
    const markup = message.replyMarkup;
    if (!(markup instanceof Api.ReplyInlineMarkup)) return null;

    const buttons: TelegramButton[] = [];
    for (const row of markup.rows) {
      for (const button of row.buttons) {
        if (button instanceof Api.KeyboardButtonUrl) {
          buttons.push({ text: button.text, url: button.url });
        } else if (button instanceof Api.KeyboardButtonUrlAuth) {
          buttons.push({ text: button.text, url: button.url });
        }
      }
    }

    return buttons.length > 0 ? buttons : null;
  }

  /** True while a recent getEntity failure for this key is still within its retry TTL. */
  private entityRecentlyFailed(key: string): boolean {
    const failedAt = this.entityFailures.get(key);
    if (failedAt === undefined) return false;
    if (Date.now() - failedAt > ENTITY_FAILURE_TTL_MS) {
      this.entityFailures.delete(key);
      return false;
    }
    return true;
  }

  private recordEntityFailure(key: string): void {
    if (this.entityFailures.size >= ENTITY_FAILURE_MAX) {
      // Insertion order = oldest first; dropping the head keeps the map bounded.
      const oldest = this.entityFailures.keys().next().value;
      if (oldest !== undefined) this.entityFailures.delete(oldest);
    }
    this.entityFailures.set(key, Date.now());
  }

  private async resolveChat(message: Api.Message): Promise<TelegramChat | null> {
    if (!message.peerId) return null;
    const chatId = this.peerToId(message.peerId);
    const cached = this.chatCache.get(chatId);
    if (cached) return cached;
    if (this.entityRecentlyFailed(`chat:${chatId}`)) return null;

    try {
      const entity = await this.client.getEntity(message.peerId);
      let chat: TelegramChat;

      if (entity instanceof Api.User) {
        chat = {
          id: chatId,
          title: entity.firstName
            ? `${entity.firstName}${entity.lastName ? ' ' + entity.lastName : ''}`
            : entity.username ?? 'Private Chat',
          type: 'user',
          username: entity.username ?? null,
        };
      } else if (entity instanceof Api.Chat) {
        chat = {
          id: chatId,
          title: entity.title ?? 'Group',
          type: 'group',
          inviteLink: await this.resolveGroupInviteLink(entity.id),
        };
      } else if (entity instanceof Api.Channel) {
        chat = {
          id: chatId,
          title: entity.title ?? 'Channel',
          type: entity.megagroup ? 'supergroup' : 'channel',
          username: entity.username ?? null,
          // Topic-enabled supergroup — the picker offers per-topic subscription for these.
          isForum: !!entity.forum,
        };
      } else {
        return null;
      }

      this.chatCache.set(chatId, chat);
      return chat;
    } catch {
      this.recordEntityFailure(`chat:${chatId}`);
      return null;
    }
  }

  // Basic (legacy) groups have no public per-message permalink, so the only way
  // to open them in Telegram is via an invite link. Prefer an existing exported
  // invite; fall back to exporting one (requires invite permission).
  private async resolveGroupInviteLink(chatId: Api.Chat['id']): Promise<string | null> {
    try {
      const full = await this.client.invoke(new Api.messages.GetFullChat({ chatId }));
      const existing = (full.fullChat as any)?.exportedInvite;
      if (existing instanceof Api.ChatInviteExported) return existing.link;
    } catch {
      // ignore - fall through to export attempt
    }
    try {
      const exported = await this.client.invoke(
        new Api.messages.ExportChatInvite({ peer: new Api.InputPeerChat({ chatId }) }),
      );
      if (exported instanceof Api.ChatInviteExported) return exported.link;
    } catch {
      // ignore - no permission or unavailable
    }
    return null;
  }

  /**
   * The forum topics of a topic-enabled supergroup, oldest-topic-first as Telegram returns them.
   *
   * Also the topic-title source for ingestion: every title seen here lands in `topicTitles`, so
   * later messages in those topics carry a real name instead of the "Topic <id>" fallback. This
   * TL layer exposes the call as `messages.GetForumTopics` (peer-based); the offset triple is the
   * pagination cursor and zeroes mean "from the top" — 100 topics covers any real group's list.
   * Returns [] on any failure (not-a-forum, no access, flood-wait) rather than throwing: the
   * caller is a picker, and an empty list is the honest render for every one of those cases.
   */
  async getForumTopics(chatId: string): Promise<TelegramForumTopic[]> {
    try {
      const entity = await this.client.getEntity(chatId);
      const res = await this.client.invoke(
        new Api.messages.GetForumTopics({
          peer: entity,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: 100,
        }),
      );
      const topics: TelegramForumTopic[] = [];
      for (const t of res.topics ?? []) {
        if (!(t instanceof Api.ForumTopic)) continue; // skip ForumTopicDeleted
        topics.push({ id: t.id, title: t.title, closed: t.closed ? true : undefined });
        this.topicTitles.set(`${chatId}:${t.id}`, t.title);
      }
      return topics;
    } catch (err: any) {
      console.warn(`[Telegram] getForumTopics failed for ${chatId}:`, err.message);
      return [];
    }
  }

  /**
   * Topic title from the cache, kicking off ONE background refresh per chat when an unknown
   * topic appears mid-stream. The current message keeps the null (rendered as "Topic <id>");
   * every following message in that topic gets the real name. Deliberately not awaited — a
   * title is cosmetic and must never delay or fail message ingestion.
   */
  private topicTitleFor(chatId: string, topicId: number | null): string | null {
    if (topicId == null) return null;
    const key = `${chatId}:${topicId}`;
    const known = this.topicTitles.get(key);
    if (known !== undefined) return known;
    if (!this.topicFetchInFlight.has(chatId)) {
      this.topicFetchInFlight.add(chatId);
      void this.getForumTopics(chatId).finally(() => this.topicFetchInFlight.delete(chatId));
    }
    return null;
  }

  /** Cached reply snippet: the value (possibly null = known-missing), or undefined on miss/expiry. */
  private replyCacheGet(key: string): TelegramRawMessage['replyTo'] | undefined {
    const entry = this.replyCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > entry.ttl) {
      this.replyCache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private replyCacheSet(key: string, value: TelegramRawMessage['replyTo']): void {
    // Map preserves insertion order, so evicting the first keys drops the oldest entries.
    if (this.replyCache.size >= REPLY_CACHE_MAX) {
      const drop = Math.ceil(REPLY_CACHE_MAX / 10);
      let i = 0;
      for (const k of this.replyCache.keys()) {
        this.replyCache.delete(k);
        if (++i >= drop) break;
      }
    }
    const ttl = value === null ? REPLY_CACHE_MISS_TTL_MS : REPLY_CACHE_TTL_MS;
    this.replyCache.set(key, { value, ts: Date.now(), ttl });
  }

  private async resolveSender(message: Api.Message): Promise<TelegramSender | null> {
    const senderId = message.senderId?.toString();
    if (!senderId) {
      if (message.peerId) {
        const chatId = this.peerToId(message.peerId);
        const chat = this.chatCache.get(chatId);
        if (chat) {
          return {
            id: chatId,
            username: null,
            firstName: chat.title,
            lastName: null,
            photo: `/api/telegram/avatar/${chatId}`,
          };
        }
      }
      return null;
    }

    const cached = this.senderCache.get(senderId);
    if (cached) return cached;
    if (this.entityRecentlyFailed(`sender:${senderId}`)) {
      return { id: senderId, username: null, firstName: 'Unknown', lastName: null, photo: null };
    }

    try {
      const entity = await this.client.getEntity(message.senderId!);
      let sender: TelegramSender;

      if (entity instanceof Api.User) {
        sender = {
          id: senderId,
          username: entity.username ?? null,
          firstName: entity.firstName ?? '',
          lastName: entity.lastName ?? null,
          photo: entity.photo ? `/api/telegram/avatar/${senderId}` : null,
        };
      } else if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
        sender = {
          id: senderId,
          username: (entity as any).username ?? null,
          firstName: (entity as any).title ?? 'Unknown',
          lastName: null,
          photo: (entity as any).photo ? `/api/telegram/avatar/${senderId}` : null,
        };
      } else {
        return null;
      }

      this.senderCache.set(senderId, sender);
      return sender;
    } catch {
      this.recordEntityFailure(`sender:${senderId}`);
      return { id: senderId, username: null, firstName: 'Unknown', lastName: null, photo: null };
    }
  }

  private async resolveMedia(message: Api.Message): Promise<TelegramMedia | null> {
    if (!message.media) return null;

    // Skip stickers (handled separately) and polls
    if (message.media instanceof Api.MessageMediaDocument) {
      const doc = message.media.document;
      if (doc instanceof Api.Document) {
        const isSticker = doc.attributes.some(
          (a) => a instanceof Api.DocumentAttributeSticker
        );
        if (isSticker) return null;

        const isAnimated = doc.attributes.some(
          (a) => a instanceof Api.DocumentAttributeAnimated
        );
        const videoAttr = doc.attributes.find(
          (a) => a instanceof Api.DocumentAttributeVideo
        ) as Api.DocumentAttributeVideo | undefined;
        const filenameAttr = doc.attributes.find(
          (a) => a instanceof Api.DocumentAttributeFilename
        ) as Api.DocumentAttributeFilename | undefined;

        let type: TelegramMedia['type'] = 'document';
        if (isAnimated) type = 'gif';
        else if (videoAttr) type = 'video';
        else if (doc.mimeType?.startsWith('audio/')) type = 'audio';
        else if (doc.mimeType === 'audio/ogg') type = 'voice';

        return {
          type,
          url: '', // Will be resolved via download URL
          filename: filenameAttr?.fileName ?? `file_${message.id}`,
          size: Number(doc.size),
          mimeType: doc.mimeType ?? undefined,
          width: videoAttr?.w,
          height: videoAttr?.h,
        };
      }
    }

    if (message.media instanceof Api.MessageMediaPhoto) {
      const photo = message.media.photo;
      if (photo instanceof Api.Photo) {
        const biggest = photo.sizes
          .filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize)
          .sort((a, b) => b.size - a.size)[0];

        return {
          type: 'photo',
          url: '', // Will be resolved via download URL
          filename: `photo_${message.id}.jpg`,
          size: biggest?.size ?? 0,
          mimeType: 'image/jpeg',
          width: biggest?.w,
          height: biggest?.h,
        };
      }
    }

    return null;
  }

  private async resolveSticker(message: Api.Message): Promise<TelegramRawMessage['sticker']> {
    if (!message.media || !(message.media instanceof Api.MessageMediaDocument)) return null;

    const doc = message.media.document;
    if (!(doc instanceof Api.Document)) return null;

    const stickerAttr = doc.attributes.find(
      (a) => a instanceof Api.DocumentAttributeSticker
    ) as Api.DocumentAttributeSticker | undefined;
    if (!stickerAttr) return null;

    const isAnimated = doc.mimeType === 'application/x-tgsticker' || doc.mimeType === 'video/webm';

    return {
      url: '', // Sticker preview - would need download
      emoji: stickerAttr.alt ?? undefined,
      isAnimated,
    };
  }

  private resolvePoll(message: Api.Message): TelegramRawMessage['poll'] {
    if (!message.media || !(message.media instanceof Api.MessageMediaPoll)) return null;

    const poll = message.media.poll;
    const results = message.media.results;

    return {
      question: typeof poll.question === 'string'
        ? poll.question
        : (poll.question as any)?.text ?? '',
      options: poll.answers.map((answer, i) => {
        const text = typeof answer.text === 'string'
          ? answer.text
          : (answer.text as any)?.text ?? '';
        const voters = results?.results?.[i]?.voters ?? 0;
        return { text, voters };
      }),
    };
  }

  private peerToId(peer: Api.TypePeer): string {
    if (peer instanceof Api.PeerUser) return peer.userId.toString();
    if (peer instanceof Api.PeerChat) return `-${peer.chatId}`;
    if (peer instanceof Api.PeerChannel) return `-100${peer.channelId}`;
    return '0';
  }

  async getChats(): Promise<TelegramChat[]> {
    const chats: TelegramChat[] = [];
    try {
      const dialogs = await this.client.getDialogs({ limit: 200 });
      for (const dialog of dialogs) {
        const entity = dialog.entity;
        if (!entity) continue;

        let chat: TelegramChat | null = null;

        if (entity instanceof Api.User) {
          if (entity.bot || entity.self) continue;
          chat = {
            id: entity.id.toString(),
            title: entity.firstName
              ? `${entity.firstName}${entity.lastName ? ' ' + entity.lastName : ''}`
              : entity.username ?? 'User',
            type: 'user',
            username: entity.username ?? null,
          };
        } else if (entity instanceof Api.Chat) {
          chat = {
            id: `-${entity.id}`,
            title: entity.title ?? 'Group',
            type: 'group',
          };
        } else if (entity instanceof Api.Channel) {
          chat = {
            id: `-100${entity.id}`,
            title: entity.title ?? 'Channel',
            type: entity.megagroup ? 'supergroup' : 'channel',
            username: entity.username ?? null,
            // The picker keys the per-topic subscription UI off this flag.
            isForum: !!entity.forum,
          };
        }

        if (chat) {
          chats.push(chat);
          this.chatCache.set(chat.id, chat);
        }
      }
    } catch (err: any) {
      console.error('[Telegram] Failed to fetch chats:', err.message);
    }
    return chats;
  }

  async fetchMessages(channelId: string, limit = 30): Promise<TelegramRawMessage[]> {
    const messages: TelegramRawMessage[] = [];
    // A forum-topic room's channel id is `chatId:topicId` (see
    // telegram/messageProcessor.ts). getEntity has never understood that shape,
    // so every history load for a topic room threw "Cannot find any entity" and
    // the room opened empty — the repeating log line was the symptom, the empty
    // pane was the bug.
    const { chatId, topicId } = splitTopicChannelId(channelId);
    try {
      const entity = await this.client.getEntity(chatId);
      const result = await this.fetchHistory(entity, topicId, limit);

      // One batched fetch seeds the reply cache with every uncached reply root on the
      // page — previously each reply-bearing message cost its own serial getMessages
      // round-trip inside buildRawMessage (up to `limit` round-trips per history load).
      let chatKey: string | null = null;
      const wanted: number[] = [];
      for (const msg of result) {
        if (!msg || !(msg instanceof Api.Message) || !msg.peerId) continue;
        chatKey ??= this.peerToId(msg.peerId);
        const rt = msg.replyTo;
        if (!rt || !isGenuineReply(rt) || !('replyToMsgId' in rt) || !rt.replyToMsgId) continue;
        const id = rt.replyToMsgId;
        if (!wanted.includes(id) && this.replyCacheGet(`${chatKey}:${id}`) === undefined) {
          wanted.push(id);
        }
      }
      if (chatKey && wanted.length > 0) {
        try {
          const replies = await this.client.getMessages(entity, { ids: wanted });
          for (let i = 0; i < wanted.length; i++) {
            const r = replies[i];
            let value: TelegramRawMessage['replyTo'] = null;
            if (r) {
              const replySender = await this.resolveSender(r);
              value = { id: r.id, senderName: replySender?.firstName ?? 'Unknown', text: r.text ?? '' };
            }
            this.replyCacheSet(`${chatKey}:${wanted[i]}`, value);
          }
        } catch {
          // Batch failed — buildRawMessage falls back to per-message resolution below.
        }
      }

      for (const msg of result) {
        if (!msg || !(msg instanceof Api.Message)) continue;
        const raw = await this.buildRawMessage(msg);
        // Belt and braces for the fallback path in fetchHistory: an unscoped
        // read of a forum must not leak another topic's messages into this room.
        if (raw && (topicId == null || raw.topicId === topicId)) messages.push(raw);
      }
    } catch (err: any) {
      console.error(`[Telegram] Failed to fetch messages for ${channelId}:`, err.message);
    }
    return messages.reverse();
  }

  /**
   * History for a chat, or for one forum topic within it.
   *
   * `replyTo` is how MTProto scopes a history read to a topic (the topic root
   * message id is the thread id). It is not universally accepted — the General
   * topic has no root, and non-forum supergroups reject it — so a failure falls
   * back to the plain chat history rather than surfacing as an empty room.
   */
  private async fetchHistory(
    entity: Parameters<GramJSClient['getMessages']>[0],
    topicId: number | null,
    limit: number,
  ): Promise<Awaited<ReturnType<GramJSClient['getMessages']>>> {
    if (topicId != null) {
      try {
        return await this.client.getMessages(entity, { limit, replyTo: topicId });
      } catch {
        // Fall through to the unscoped read below.
      }
    }
    return await this.client.getMessages(entity, { limit });
  }

  async downloadMediaByIds(chatId: string, messageId: number): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
      const entity = await this.client.getEntity(chatId);
      const msgs = await this.client.getMessages(entity, { ids: [messageId] });
      const msg = msgs[0];
      if (!msg || !(msg instanceof Api.Message) || !msg.media) return null;

      let mimeType = 'application/octet-stream';
      if (msg.media instanceof Api.MessageMediaPhoto) {
        mimeType = 'image/jpeg';
      } else if (msg.media instanceof Api.MessageMediaDocument) {
        const doc = msg.media.document;
        if (doc instanceof Api.Document) {
          mimeType = doc.mimeType ?? 'application/octet-stream';
        }
      }

      const buffer = await this.client.downloadMedia(msg);
      if (!buffer || !(buffer instanceof Buffer)) return null;
      return { buffer, mimeType };
    } catch (err: any) {
      console.error(`[Telegram] Failed to download media ${chatId}/${messageId}:`, err.message);
      return null;
    }
  }

  /**
   * A user's avatar, or null.
   *
   * NULL IS ORDINARY HERE, not a fault. The avatar route is called once per
   * distinct sender the console renders, and a sender the session has never
   * resolved (no access hash — a member of a group we only read) simply has no
   * input entity. That produced one `console.error` per request forever: the
   * route caches successes only, so every re-render of the same message re-asked
   * and re-logged. Failures now go through the same negative cache as chat and
   * sender resolution — one attempt and one log line per peer per TTL window.
   */
  async downloadProfilePhoto(peerId: string): Promise<Buffer | null> {
    const key = `photo:${peerId}`;
    if (this.entityRecentlyFailed(key)) return null;
    try {
      const entity = await this.client.getEntity(peerId);
      const buffer = await this.client.downloadProfilePhoto(entity);
      if (!buffer || !(buffer instanceof Buffer) || buffer.length === 0) {
        // No photo set is a permanent-enough answer to be worth not re-asking.
        this.recordEntityFailure(key);
        return null;
      }
      return buffer;
    } catch (err: any) {
      this.recordEntityFailure(key);
      console.warn(`[Telegram] No profile photo for ${peerId}: ${err.message}`);
      return null;
    }
  }

  async sendMessage(
    chatId: string,
    content: string,
    attachments?: { filename: string; data: Buffer; contentType: string }[],
  ): Promise<Api.Message> {
    const entity = await this.client.getEntity(chatId);

    if (attachments && attachments.length > 0) {
      const { CustomFile } = await import('teleproto/client/uploads.js');
      const first = attachments[0];
      const customFile = new CustomFile(first.filename, first.data.length, '', first.data);
      const result = await this.client.sendFile(entity, {
        file: customFile,
        caption: content || undefined,
        forceDocument: !first.contentType.startsWith('image/'),
      });

      for (let i = 1; i < attachments.length; i++) {
        const att = attachments[i];
        const f = new CustomFile(att.filename, att.data.length, '', att.data);
        await this.client.sendFile(entity, {
          file: f,
          forceDocument: !att.contentType.startsWith('image/'),
        });
      }

      return result as Api.Message;
    }

    return this.client.sendMessage(entity, { message: content });
  }

  getChatName(chatId: string): string {
    return this.chatCache.get(chatId)?.title ?? 'Unknown';
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    this.disposed = true;
    this.connected = false;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.client.disconnect().catch(() => {});
  }
}
