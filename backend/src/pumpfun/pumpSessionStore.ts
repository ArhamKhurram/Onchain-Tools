// Local-mode store for the user's pump.fun session bearer.
//
// WHY THIS IS A STANDALONE FILE, NOT A FIELD ON AppConfig: the bearer is a
// 30-day JWT that authenticates AS the user, so it must never ride out through
// GET /config or a settings export. Discord tokens live inside AppConfig and are
// stripped by hand at every egress (config.ts strips `discordTokens`); one missed
// strip there would leak a credential. Keeping the pump bearer in its OWN file,
// persisted to its OWN JSON, means there is no AppConfig surface it can leak
// through — it is simply not reachable from any config route. That isolation is
// worth more here than mirroring the discord-token layout exactly.
//
// It is PLAINTEXT on disk, and that is deliberate and acceptable: local mode has
// no auth, binds loopback (127.0.0.1), and already serves Discord tokens and
// Telegram sessions in the clear from config.json. Hosted mode is where the
// bearer is AES-256-GCM encrypted at rest (see storage/supabase/pumpSessionRepo).
//
// The token is written and read here and NOWHERE logged: no console line in this
// file ever names the token, and the getter hands back an in-process record that
// the routes are disciplined never to serialize.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PumpSession } from '../storage/interface.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same writable-dir convention as config/store.ts so a packaged (read-only)
// install still persists to the relocated userData dir.
const BUNDLED_DATA_DIR = join(__dirname, '../../data');
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || BUNDLED_DATA_DIR;
const SESSION_PATH = join(DATA_DIR, 'pump-session.json');

interface PersistedSession {
  token: string;
  updatedAt: string;
}

/**
 * Single-user (local-mode) store. One process, one implicit user, so the session
 * is held in memory and mirrored to a JSON file. The userId is ignored — it exists
 * only so the caller's signature matches the multi-user StorageProvider.
 */
class PumpSessionStore {
  private session: PersistedSession | null;

  constructor() {
    this.session = this.load();
  }

  private load(): PersistedSession | null {
    try {
      if (!existsSync(SESSION_PATH)) return null;
      const raw = readFileSync(SESSION_PATH, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>).token === 'string' &&
        (parsed as Record<string, unknown>).token !== ''
      ) {
        const rec = parsed as Record<string, unknown>;
        const updatedAt = typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString();
        return { token: rec.token as string, updatedAt };
      }
    } catch {
      // A corrupt or unreadable file behaves as "not connected"; the next connect
      // overwrites it. Nothing is logged — an error line could echo file contents.
    }
    return null;
  }

  /** The stored session, or null when the user has not connected. */
  getSession(): PumpSession | null {
    return this.session ? { token: this.session.token, updatedAt: this.session.updatedAt } : null;
  }

  /** Store a bearer, or clear it when passed null. Stamps `updatedAt` on write. */
  setSession(token: string | null): void {
    if (token === null || token === '') {
      this.session = null;
      try {
        // Remove rather than write `{}` so a wiped session leaves nothing on disk.
        if (existsSync(SESSION_PATH)) rmSync(SESSION_PATH);
      } catch {
        // Best effort; the in-memory clear is the source of truth for this process.
      }
      return;
    }

    this.session = { token, updatedAt: new Date().toISOString() };
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(SESSION_PATH, JSON.stringify(this.session), 'utf-8');
    } catch {
      // Persist failure is non-fatal for the current process; do not log (the
      // error object could carry the path but must never carry the token).
    }
  }
}

export const pumpSessionStore = new PumpSessionStore();
