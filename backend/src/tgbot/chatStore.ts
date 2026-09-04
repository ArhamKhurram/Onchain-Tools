// Per-chat tenancy for the Telegram bot: the roster of chats it serves.
//
// THE TENANT IS THE CHAT. Every other OCT ingestion path is keyed by an OCT
// user because the user handed over a credential. This one is not: the bot has
// its own token and the chat is the unit of state. So this is a sibling of
// StorageProvider rather than a method on it — same dual-mode shape (JSON in
// local, Supabase in hosted), different key.
//
// EGRESS. The alert fan-out asks for the enabled chat list on EVERY alert, and
// on a busy feed that is several reads a minute forever. Two things keep it
// cheap: the list is cached in-process behind a short TTL and invalidated on
// write, and the hosted read is column-scoped — never `select('*')` on a table
// that carries a JSONB settings blob and an entitlements blob per row.
//
// The table (supabase/migrations/20260903120000_tg_bot_chats.sql) is not in the
// generated database.types.ts snapshot — that file is regenerated wholesale and
// never hand-edited — so the queries here run on the untyped client, exactly
// like storage/supabase/revivalAlertsRepo.ts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getFomoServiceClient } from '../fomo/store.js';
import { isHostedMode } from '../storage/index.js';
import { DEFAULT_CHAT_SETTINGS, readSettings, type TgChatSettings } from './alertPolicy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same writable-dir convention as config/store.ts, so a packaged (read-only)
// desktop install still persists to the relocated userData dir.
const BUNDLED_DATA_DIR = join(__dirname, '../../data');
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || BUNDLED_DATA_DIR;
const CHATS_PATH = join(DATA_DIR, 'tg-bot-chats.json');

/** How long the enabled-chat list is trusted before it is re-read. */
const LIST_CACHE_MS = 60_000;

// The settings SHAPE lives in alertPolicy.ts, next to the alert catalog it
// describes and free of any I/O, so the fail-closed default is a pure value a
// test can assert on. Re-exported here because this is where callers reach for
// per-chat state.
export { DEFAULT_CHAT_SETTINGS, readSettings };
export type { TgChatSettings };

export interface TgChatRecord {
  chatId: number;
  chatType: string;
  title: string | null;
  addedByTgUserId: number | null;
  enabled: boolean;
  /** Whose OCT alerts this chat receives; null = the instance default. */
  sourceUserId: string | null;
  settings: TgChatSettings;
  /** Future paid tier — echoed by /status, gated on by nothing yet. */
  plan: string;
  entitlements: Record<string, unknown>;
  createdAt: string;
}

export interface RegisterChatInput {
  chatId: number;
  chatType: string;
  title: string | null;
  addedByTgUserId: number | null;
}

/** The columns every read asks for. Never `*` — see the egress note above. */
const CHAT_COLUMNS =
  'chat_id, chat_type, title, added_by_tg_user_id, enabled, source_user_id, settings, plan, entitlements, created_at';

function rowToRecord(row: Record<string, unknown>): TgChatRecord {
  return {
    chatId: Number(row.chat_id),
    chatType: typeof row.chat_type === 'string' ? row.chat_type : 'unknown',
    title: typeof row.title === 'string' ? row.title : null,
    addedByTgUserId: row.added_by_tg_user_id != null ? Number(row.added_by_tg_user_id) : null,
    enabled: row.enabled !== false,
    sourceUserId: typeof row.source_user_id === 'string' ? row.source_user_id : null,
    settings: readSettings(row.settings),
    plan: typeof row.plan === 'string' ? row.plan : 'free',
    entitlements:
      row.entitlements && typeof row.entitlements === 'object'
        ? (row.entitlements as Record<string, unknown>)
        : {},
    createdAt: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
  };
}

/**
 * The chat roster. One instance per process; `getChatStore()` below.
 *
 * Every method resolves rather than rejecting: a Supabase outage must cost the
 * bot its persistence, not its ability to answer /help.
 */
class TgChatStore {
  private db: SupabaseClient | null = null;
  private local: Map<number, TgChatRecord> | null = null;
  private enabledCache: { rows: TgChatRecord[]; expiresAt: number } | null = null;
  /** Logged once, not per call, when hosted mode has no Supabase configured. */
  private warnedNoDb = false;

  private hosted(): boolean {
    return isHostedMode();
  }

  private client(): SupabaseClient | null {
    if (!this.db) this.db = getFomoServiceClient();
    if (!this.db && !this.warnedNoDb) {
      this.warnedNoDb = true;
      console.warn(
        '[TgBot] Hosted mode without a Supabase service client — chat registrations will not persist.',
      );
    }
    return this.db;
  }

  // --- local (JSON) backend -----------------------------------------------

  private loadLocal(): Map<number, TgChatRecord> {
    if (this.local) return this.local;
    const map = new Map<number, TgChatRecord>();
    try {
      if (existsSync(CHATS_PATH)) {
        const parsed: unknown = JSON.parse(readFileSync(CHATS_PATH, 'utf-8'));
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (!entry || typeof entry !== 'object') continue;
            const row = entry as Record<string, unknown>;
            if (typeof row.chat_id !== 'number') continue;
            const record = rowToRecord(row);
            map.set(record.chatId, record);
          }
        }
      }
    } catch (err) {
      // A corrupt file reads as an empty roster; the next /start rewrites it.
      console.warn('[TgBot] Could not read the local chat roster:', (err as Error)?.message ?? err);
    }
    this.local = map;
    return map;
  }

  private saveLocal(): void {
    const map = this.loadLocal();
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const rows = [...map.values()].map((r) => ({
        chat_id: r.chatId,
        chat_type: r.chatType,
        title: r.title,
        added_by_tg_user_id: r.addedByTgUserId,
        enabled: r.enabled,
        source_user_id: r.sourceUserId,
        settings: r.settings,
        plan: r.plan,
        entitlements: r.entitlements,
        created_at: r.createdAt,
      }));
      writeFileSync(CHATS_PATH, JSON.stringify(rows, null, 2));
    } catch (err) {
      console.error('[TgBot] Could not write the local chat roster:', (err as Error)?.message ?? err);
    }
  }

  // --- public API ----------------------------------------------------------

  /** Drop the cached enabled-chat list. Called after every write. */
  private invalidate(): void {
    this.enabledCache = null;
  }

  /**
   * Register (or re-register) a chat from /start.
   *
   * An upsert, and re-running /start deliberately re-enables a chat that was
   * auto-disabled by a 403: kicking the bot out and adding it back is the
   * clearest possible statement of intent, and it is the only path back.
   * `settings`, `plan` and `entitlements` are NOT touched — a re-/start must
   * not silently reset prefs somebody set.
   */
  async register(input: RegisterChatInput): Promise<TgChatRecord | null> {
    const now = new Date().toISOString();

    if (!this.hosted()) {
      const map = this.loadLocal();
      const existing = map.get(input.chatId);
      const record: TgChatRecord = {
        chatId: input.chatId,
        chatType: input.chatType,
        title: input.title,
        addedByTgUserId: input.addedByTgUserId ?? existing?.addedByTgUserId ?? null,
        enabled: true,
        sourceUserId: existing?.sourceUserId ?? null,
        // A fresh chat starts subscribed to NOTHING (see alertPolicy.ts).
        // Cloned one level down because `alerts` is a nested object and the
        // default must not become shared mutable state across chats.
        settings: existing?.settings ?? {
          ...DEFAULT_CHAT_SETTINGS,
          alerts: { ...DEFAULT_CHAT_SETTINGS.alerts },
        },
        plan: existing?.plan ?? 'free',
        entitlements: existing?.entitlements ?? {},
        createdAt: existing?.createdAt ?? now,
      };
      map.set(record.chatId, record);
      this.saveLocal();
      this.invalidate();
      return record;
    }

    const db = this.client();
    if (!db) return null;

    const { data, error } = await db
      .from('tg_bot_chats')
      .upsert(
        {
          chat_id: input.chatId,
          chat_type: input.chatType,
          title: input.title,
          added_by_tg_user_id: input.addedByTgUserId,
          enabled: true,
        },
        { onConflict: 'chat_id' },
      )
      .select(CHAT_COLUMNS)
      .single();

    if (error) {
      console.error('[TgBot] Chat registration failed:', error.message);
      return null;
    }
    this.invalidate();
    return data ? rowToRecord(data as Record<string, unknown>) : null;
  }

  /** One chat's record, or null when it has never run /start. */
  async get(chatId: number): Promise<TgChatRecord | null> {
    if (!this.hosted()) return this.loadLocal().get(chatId) ?? null;

    const db = this.client();
    if (!db) return null;

    const { data, error } = await db
      .from('tg_bot_chats')
      .select(CHAT_COLUMNS)
      .eq('chat_id', chatId)
      .maybeSingle();

    if (error) {
      console.error('[TgBot] Chat lookup failed:', error.message);
      return null;
    }
    return data ? rowToRecord(data as Record<string, unknown>) : null;
  }

  /** Every enabled chat. Cached for LIST_CACHE_MS; invalidated by writes. */
  async listEnabled(): Promise<TgChatRecord[]> {
    const cached = this.enabledCache;
    if (cached && Date.now() < cached.expiresAt) return cached.rows;

    let rows: TgChatRecord[] = [];
    if (!this.hosted()) {
      rows = [...this.loadLocal().values()].filter((r) => r.enabled);
    } else {
      const db = this.client();
      if (db) {
        const { data, error } = await db
          .from('tg_bot_chats')
          .select(CHAT_COLUMNS)
          .eq('enabled', true)
          .order('created_at', { ascending: false });
        if (error) {
          console.error('[TgBot] Chat list failed:', error.message);
          // Serve the stale list rather than going silent on a transient error.
          return cached?.rows ?? [];
        }
        rows = (data ?? []).map((r) => rowToRecord(r as Record<string, unknown>));
      }
    }

    this.enabledCache = { rows, expiresAt: Date.now() + LIST_CACHE_MS };
    return rows;
  }

  /**
   * Turn a chat off. Called when Telegram tells us the bot can no longer post
   * there (kicked, blocked, chat deleted) — the row is kept so /start can
   * restore it and so the registration history survives.
   */
  async disable(chatId: number, reason: string): Promise<void> {
    console.warn(`[TgBot] Disabling chat ${chatId}: ${reason}`);

    if (!this.hosted()) {
      const map = this.loadLocal();
      const record = map.get(chatId);
      if (record) {
        map.set(chatId, { ...record, enabled: false });
        this.saveLocal();
      }
      this.invalidate();
      return;
    }

    const db = this.client();
    if (!db) return;
    const { error } = await db.from('tg_bot_chats').update({ enabled: false }).eq('chat_id', chatId);
    if (error) console.error('[TgBot] Could not disable chat:', error.message);
    this.invalidate();
  }

  /**
   * Replace one chat's alert preferences.
   *
   * The whole blob is written rather than a JSONB merge: `settings` is small,
   * the callers all read-modify-write it in one command handler, and a partial
   * merge is how a key that was meant to be turned OFF survives. Returns false
   * when the write did not land, so /alerts can say so instead of confirming a
   * subscription change that did not happen.
   *
   * Invalidates the enabled-chat cache, because the fan-out reads settings off
   * exactly those cached rows — without this a chat that just opted out would
   * keep receiving alerts for up to LIST_CACHE_MS.
   */
  async updateSettings(chatId: number, settings: TgChatSettings): Promise<boolean> {
    if (!this.hosted()) {
      const map = this.loadLocal();
      const record = map.get(chatId);
      if (!record) return false;
      map.set(chatId, { ...record, settings });
      this.saveLocal();
      this.invalidate();
      return true;
    }

    const db = this.client();
    if (!db) return false;

    const { error } = await db.from('tg_bot_chats').update({ settings }).eq('chat_id', chatId);
    if (error) {
      console.error('[TgBot] Could not update chat settings:', error.message);
      return false;
    }
    this.invalidate();
    return true;
  }

  /** Test seam — drops cached state so a fresh env/backend takes effect. */
  reset(): void {
    this.db = null;
    this.local = null;
    this.enabledCache = null;
    this.warnedNoDb = false;
  }
}

let store: TgChatStore | null = null;

export function getChatStore(): TgChatStore {
  if (!store) store = new TgChatStore();
  return store;
}

export type { TgChatStore };
