import { EventEmitter } from 'events';
import { TelegramClientWrapper } from './client.js';
import type { TelegramChat, TelegramForumTopic, TelegramRawMessage } from './types.js';

/**
 * How long a message id stays remembered for dedupe.
 *
 * This is not sized against two clients delivering the same message at once —
 * that is a matter of seconds, and what the original 10s window was built for.
 * It is sized against the update stream RE-DELIVERING a message: teleproto
 * replays a message after a reconnect or an `updates.getDifference` gap
 * recovery, and the measured production gap between two deliveries of one
 * message is a median ~116s, p90 ~31min, p99 ~2.1h, max ~2.9h (the numbers
 * #368 collected). A 10s window caught 18.7% of them, so four in five
 * re-deliveries ran the whole ingest handler again.
 *
 * #368 and #372 made the two storage-facing effects of that handler
 * idempotent — no second `contracts` row, and the re-broadcast is flagged so
 * the feed drops it — but the rest of it (Pushover, the keyword and scan
 * alerts, the message frame) is fire-and-forget, so a re-delivery still landed
 * as a second ping. Only the transport can make ALL of them fire once, so the
 * retention is set past the measured tail rather than at the multi-client
 * window that no longer describes what this guard is for.
 */
const DEDUP_RETENTION_MS = 3 * 60 * 60_000;
/** How often expired ids are swept. Independent of the retention above. */
const DEDUP_SWEEP_MS = 60_000;
/**
 * Hard bound on the remembered set, and the real limit on how far back the
 * guard can see: retention is whichever comes first, DEDUP_RETENTION_MS or the
 * time it takes the subscribed chats to produce this many messages. A feed busy
 * enough to evict early degrades to a shorter window rather than to the old
 * 10s one, which is the axis that matters. ~20k short keys is a couple of MB
 * per connected account.
 */
const DEDUP_MAX_SIZE = 20_000;

export class TelegramClientManager extends EventEmitter {
  private clients: TelegramClientWrapper[] = [];
  private recentMessageIds = new Map<string, number>();
  private dedupeTimer: ReturnType<typeof setInterval> | null = null;
  private readyCount = 0;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void>;

  constructor(
    apiId: number,
    apiHash: string,
    sessions: string[],
  ) {
    super();
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    for (const session of sessions) {
      const client = new TelegramClientWrapper(apiId, apiHash, session);
      this.clients.push(client);
      this.wireEvents(client);
    }
    if (sessions.length === 0) {
      this.readyResolve?.();
    }
  }

  private wireEvents(client: TelegramClientWrapper): void {
    client.on('message', (raw: TelegramRawMessage) => {
      // `chatId:id` is the identity of the message, not of this delivery of it,
      // so a re-delivery hours later is recognised as exactly as a duplicate as
      // one that arrives a second later.
      const key = `${raw.chatId}:${raw.id}`;
      const now = Date.now();
      if (this.recentMessageIds.has(key)) return;
      this.recentMessageIds.set(key, now);
      // A known key returns above and is never re-stamped, so insertion order
      // is age order and the first entry is the oldest. Evicting here as well
      // as on the sweep keeps DEDUP_MAX_SIZE a hard bound between sweeps.
      if (this.recentMessageIds.size > DEDUP_MAX_SIZE) {
        const oldest = this.recentMessageIds.keys().next();
        if (!oldest.done) this.recentMessageIds.delete(oldest.value);
      }
      this.emit('message', raw);
    });

    client.on('messageUpdate', (raw: TelegramRawMessage) => {
      this.emit('messageUpdate', raw);
    });

    client.on('ready', (user: { id: string; username: string | null; firstName: string }) => {
      this.readyCount++;
      if (this.readyCount >= this.clients.length) {
        this.readyResolve?.();
      }
      this.emit('ready', user);
    });

    client.on('fatal', (err: Error) => this.emit('fatal', err));
  }

  waitUntilReady(timeoutMs = 30_000): Promise<void> {
    return Promise.race([
      this.readyPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async connect(): Promise<void> {
    this.dedupeTimer = setInterval(() => this.pruneDedup(), DEDUP_SWEEP_MS);
    for (const client of this.clients) {
      await client.connect();
    }
  }

  disconnect(): void {
    if (this.dedupeTimer) {
      clearInterval(this.dedupeTimer);
      this.dedupeTimer = null;
    }
    for (const client of this.clients) {
      client.disconnect();
    }
  }

  private pruneDedup(): void {
    const cutoff = Date.now() - DEDUP_RETENTION_MS;
    // Insertion order is age order (see wireEvents), so the first id still
    // inside the retention proves every id behind it is too — the sweep costs
    // what it expires, not the size of the set.
    for (const [id, ts] of this.recentMessageIds) {
      if (ts >= cutoff) break;
      this.recentMessageIds.delete(id);
    }
  }

  async getChats(): Promise<TelegramChat[]> {
    const merged = new Map<string, TelegramChat>();
    for (const client of this.clients) {
      const chats = await client.getChats();
      for (const chat of chats) {
        if (!merged.has(chat.id)) {
          merged.set(chat.id, chat);
        }
      }
    }
    return Array.from(merged.values());
  }

  getChatName(chatId: string): string {
    for (const client of this.clients) {
      const name = client.getChatName(chatId);
      if (name !== 'Unknown') return name;
    }
    return 'Unknown';
  }

  /** Forum topics of a topic-enabled supergroup — first client that returns any wins. */
  async getForumTopics(chatId: string): Promise<TelegramForumTopic[]> {
    for (const client of this.clients) {
      try {
        const topics = await client.getForumTopics(chatId);
        if (topics.length > 0) return topics;
      } catch {
        continue;
      }
    }
    return [];
  }

  async fetchMessages(chatId: string, limit = 30): Promise<TelegramRawMessage[]> {
    for (const client of this.clients) {
      try {
        const msgs = await client.fetchMessages(chatId, limit);
        if (msgs.length > 0) return msgs;
      } catch {
        continue;
      }
    }
    return [];
  }

  async sendMessage(
    chatId: string,
    content: string,
    attachments?: { filename: string; data: Buffer; contentType: string }[],
  ): Promise<{ id: number }> {
    for (const client of this.clients) {
      if (client.isConnected()) {
        const result = await client.sendMessage(chatId, content, attachments);
        return { id: result.id };
      }
    }
    throw new Error('No connected Telegram client available');
  }

  async downloadMediaByIds(chatId: string, messageId: number): Promise<{ buffer: Buffer; mimeType: string } | null> {
    for (const client of this.clients) {
      try {
        const result = await client.downloadMediaByIds(chatId, messageId);
        if (result) return result;
      } catch {
        continue;
      }
    }
    return null;
  }

  async downloadProfilePhoto(peerId: string): Promise<Buffer | null> {
    for (const client of this.clients) {
      try {
        const result = await client.downloadProfilePhoto(peerId);
        if (result) return result;
      } catch {
        continue;
      }
    }
    return null;
  }

  isConnected(): boolean {
    return this.clients.some((c) => c.isConnected());
  }
}
