// Link codes: the credential that binds a Telegram chat to an OCT account.
//
// THE HOLE THIS FILLS. `tg_bot_chats.source_user_id` has existed since the
// roster table shipped and its migration says outright that it is "the seam a
// future 'link this chat to my OCT account' flow fills in". Nothing wrote it,
// so `resolveAlertSource` always fell through to the env default and the panel
// permanently read "Feed: no alert source bound yet". This module is that flow's
// hard half.
//
// WHAT A BINDING ACTUALLY GRANTS, AND THEREFORE WHAT IT MUST PROVE. Binding
// chat C to account U means U's private alert stream is delivered into C, and
// (see commands/filters.ts) that C's admins can retune U's crossing thresholds.
// So the act needs proof of BOTH sides:
//
//   • proof of the OCT account — the code is minted by an AUTHENTICATED console
//     request and is never derived from anything a chat can see or guess. There
//     is no "/link <email>", no "/link <user id>", no lookup by handle. The only
//     way to obtain a valid code for account U is to already be signed in as U.
//   • proof of the chat — the code is redeemed by a message SENT IN THAT CHAT,
//     which Telegram authenticates, and (in a group) only by an admin, through
//     the same `decideChatWrite` every other write uses.
//
// Neither half is optional and neither can be replayed: a code is single-use,
// short-lived, and consumed atomically.
//
// A CODE IS A BEARER CREDENTIAL FOR ITS LIFETIME. Consequently:
//   • only its SHA-256 is stored — a database reader cannot bind with it;
//   • it is never logged, never echoed back into a chat, and never returned by
//     any endpoint after the one response that mints it;
//   • it is 40 bits of `randomBytes` entropy, redemption is rate-limited per
//     chat, and minting is rate-limited per account.
//
// WHY NOTHING IS WRITTEN TO DISK IN LOCAL MODE. A ten-minute credential that
// survives a restart in a plaintext JSON file next to the roster is a worse
// trade than losing unredeemed codes on restart. Local mode is one process and
// one user; the map is enough.

import { createHash, randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getFomoServiceClient } from '../fomo/store.js';
import { isHostedMode } from '../storage/index.js';

/** How long a minted code stays redeemable. Minutes, deliberately. */
export const LINK_CODE_TTL_MS = 10 * 60_000;

/** Minting budget per OCT account. */
export const MINT_WINDOW_MS = 15 * 60_000;
export const MINT_MAX_IN_WINDOW = 5;

/** Redemption-attempt budget per chat — the anti-guessing bound. */
export const REDEEM_WINDOW_MS = 10 * 60_000;
export const REDEEM_MAX_IN_WINDOW = 5;

/**
 * Crockford base32 without I, L, O and U: no character pair a person can
 * confuse when reading a code off one screen and typing it into another, and
 * no accidental words. 8 characters is 40 bits — 1.1e12 possibilities against
 * a five-attempts-per-ten-minutes budget.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LINK_CODE_LENGTH = 8;

/**
 * A fresh code, grouped as `ABCD-EFGH` for reading aloud.
 *
 * `randomBytes` rather than `Math.random`: this is a credential. The rejection
 * loop keeps the distribution uniform — 256 is not a multiple of 32 only if you
 * take the byte whole, so bytes ≥ 256 - (256 % 32) would bias the alphabet.
 * (32 divides 256 exactly, so the guard never fires; it is here so that
 * changing the alphabet cannot silently introduce a bias.)
 */
export function generateLinkCode(): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < LINK_CODE_LENGTH) {
    for (const byte of randomBytes(LINK_CODE_LENGTH)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === LINK_CODE_LENGTH) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Whatever a person typed, as the canonical code — or null when it cannot be
 * one.
 *
 * Separators and case are forgiving because they are transcription noise, not
 * information. The three ambiguous glyphs are folded to the digits they look
 * like, so somebody who read `0` as `O` still gets in. Everything else is
 * rejected outright rather than repaired: a "close enough" match on a bearer
 * credential is an attack surface, not a courtesy.
 */
export function normalizeLinkCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const folded = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-_.]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
  if (folded.length !== LINK_CODE_LENGTH) return null;
  for (const ch of folded) if (!ALPHABET.includes(ch)) return null;
  return `${folded.slice(0, 4)}-${folded.slice(4)}`;
}

/** The stored form. The plaintext exists only in the minting response. */
export function hashLinkCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** One minted, unredeemed code. */
export interface LinkCodeRecord {
  codeHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * The persistence the flow needs, and nothing else.
 *
 * `consume` is a single ATOMIC take: it must return the record and mark it used
 * in one step, or two people redeeming the same code in the same second would
 * both succeed. The Supabase implementation gets that from a conditional UPDATE
 * … RETURNING; the memory one from JavaScript being single-threaded.
 */
export interface LinkCodeBackend {
  /** Codes this account minted at or after `since`. Bounds minting. */
  countRecent(userId: string, since: number): Promise<number>;
  insert(record: LinkCodeRecord): Promise<boolean>;
  /** Take an unexpired, unconsumed code. Null when there is none to take. */
  consume(codeHash: string, now: number): Promise<LinkCodeRecord | null>;
}

/** Local mode, and every test. */
export class MemoryLinkCodeBackend implements LinkCodeBackend {
  private readonly codes = new Map<string, LinkCodeRecord>();
  private readonly consumed = new Set<string>();

  async countRecent(userId: string, since: number): Promise<number> {
    let n = 0;
    for (const record of this.codes.values()) {
      if (record.userId === userId && record.createdAt >= since) n += 1;
    }
    return n;
  }

  async insert(record: LinkCodeRecord): Promise<boolean> {
    // Swept on write rather than on a timer: the map only grows here, and a
    // ten-minute credential has nothing to say once it is expired.
    this.prune(record.createdAt);
    this.codes.set(record.codeHash, record);
    return true;
  }

  async consume(codeHash: string, now: number): Promise<LinkCodeRecord | null> {
    const record = this.codes.get(codeHash);
    if (!record) return null;
    if (this.consumed.has(codeHash)) return null;
    if (record.expiresAt <= now) return null;
    // Marked before returning: the caller's own await points cannot interleave
    // a second successful redemption of the same code.
    this.consumed.add(codeHash);
    return record;
  }

  /** Expired-or-consumed sweep, so a long-lived process does not grow. */
  prune(now: number): void {
    for (const [hash, record] of this.codes) {
      if (record.expiresAt <= now) {
        this.codes.delete(hash);
        this.consumed.delete(hash);
      }
    }
  }
}

/**
 * Hosted mode. Untyped client for the same reason chatStore.ts uses one: the
 * table is not in the generated `database.types.ts` snapshot.
 *
 * Requires supabase/migrations/20260908120000_tg_bot_link_codes.sql — UNAPPLIED
 * as shipped. Until it is applied every call fails, which surfaces as "linking
 * is unavailable right now" rather than as a binding that silently did not
 * happen.
 */
export class SupabaseLinkCodeBackend implements LinkCodeBackend {
  constructor(private readonly db: SupabaseClient) {}

  async countRecent(userId: string, since: number): Promise<number> {
    const { count, error } = await this.db
      .from('tg_bot_link_codes')
      .select('code_hash', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', new Date(since).toISOString());
    if (error) {
      console.error('[TgBot] Link-code budget lookup failed:', error.message);
      // Fail CLOSED: an unanswerable "have you minted too many?" is a yes.
      return MINT_MAX_IN_WINDOW;
    }
    return count ?? 0;
  }

  async insert(record: LinkCodeRecord): Promise<boolean> {
    const { error } = await this.db.from('tg_bot_link_codes').insert({
      code_hash: record.codeHash,
      user_id: record.userId,
      created_at: new Date(record.createdAt).toISOString(),
      expires_at: new Date(record.expiresAt).toISOString(),
    });
    if (error) {
      console.error('[TgBot] Link-code insert failed:', error.message);
      return false;
    }
    return true;
  }

  async consume(codeHash: string, now: number): Promise<LinkCodeRecord | null> {
    const stamp = new Date(now).toISOString();
    // The whole single-use guarantee is `.is('consumed_at', null)` on an UPDATE
    // that RETURNS the row: Postgres serializes the two writers and the loser
    // matches nothing. A read-then-write would not.
    const { data, error } = await this.db
      .from('tg_bot_link_codes')
      .update({ consumed_at: stamp })
      .eq('code_hash', codeHash)
      .is('consumed_at', null)
      .gt('expires_at', stamp)
      .select('code_hash, user_id, created_at, expires_at')
      .maybeSingle();

    if (error) {
      console.error('[TgBot] Link-code redemption failed:', error.message);
      return null;
    }
    if (!data) return null;
    const row = data as Record<string, unknown>;
    return {
      codeHash: String(row.code_hash),
      userId: String(row.user_id),
      createdAt: Date.parse(String(row.created_at)),
      expiresAt: Date.parse(String(row.expires_at)),
    };
  }
}

export type MintResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; reason: 'rate_limited' | 'unavailable' };

/**
 * Why a redemption failed.
 *
 * The CALLER collapses `invalid`, `expired` and `used` into one sentence for
 * the chat — telling a guesser which of the three they hit is free information
 * — but they stay distinct here so the tests can assert the rule rather than
 * the wording.
 */
export type RedeemResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'malformed' | 'invalid' | 'expired' | 'used' | 'throttled' | 'unavailable' };

/**
 * Mint and redeem, with the budgets attached.
 *
 * The redemption budget is in PROCESS MEMORY rather than in the database: it
 * bounds guessing, guessing happens in one chat against one running bot, and a
 * per-attempt write would put a database round trip on the path of every
 * mistyped code.
 */
export class LinkCodeService {
  private readonly attempts = new Map<number, number[]>();

  constructor(private readonly backend: LinkCodeBackend) {}

  async mint(userId: string, now: number = Date.now()): Promise<MintResult> {
    const recent = await this.backend.countRecent(userId, now - MINT_WINDOW_MS);
    if (recent >= MINT_MAX_IN_WINDOW) return { ok: false, reason: 'rate_limited' };

    const code = generateLinkCode();
    const record: LinkCodeRecord = {
      codeHash: hashLinkCode(code),
      userId,
      createdAt: now,
      expiresAt: now + LINK_CODE_TTL_MS,
    };
    if (!(await this.backend.insert(record))) return { ok: false, reason: 'unavailable' };
    return { ok: true, code, expiresAt: record.expiresAt };
  }

  /**
   * Redeem a code on behalf of one chat.
   *
   * The attempt is counted BEFORE the lookup, so a wrong code costs budget
   * whether or not it existed — otherwise the budget would only limit people
   * who were already guessing correctly.
   */
  async redeem(raw: string, chatId: number, now: number = Date.now()): Promise<RedeemResult> {
    if (!this.spendAttempt(chatId, now)) return { ok: false, reason: 'throttled' };

    const code = normalizeLinkCode(raw);
    if (!code) return { ok: false, reason: 'malformed' };

    let record: LinkCodeRecord | null;
    try {
      record = await this.backend.consume(hashLinkCode(code), now);
    } catch (err) {
      console.error('[TgBot] Link-code backend threw:', (err as Error)?.message ?? err);
      return { ok: false, reason: 'unavailable' };
    }
    if (!record) return { ok: false, reason: 'invalid' };
    return { ok: true, userId: record.userId };
  }

  private spendAttempt(chatId: number, now: number): boolean {
    const since = now - REDEEM_WINDOW_MS;
    const kept = (this.attempts.get(chatId) ?? []).filter((t) => t > since);
    if (kept.length >= REDEEM_MAX_IN_WINDOW) {
      this.attempts.set(chatId, kept);
      return false;
    }
    kept.push(now);
    this.attempts.set(chatId, kept);
    return true;
  }
}

let service: LinkCodeService | null = null;

/**
 * The process-wide service. One instance so the console's mint and the bot's
 * redeem share a backend — they run in the same process (the bot is in-process
 * in the backend), and in hosted mode they also share the table, which is what
 * makes the flow survive a second replica.
 */
export function getLinkCodeService(): LinkCodeService {
  if (!service) {
    let backend: LinkCodeBackend = new MemoryLinkCodeBackend();
    if (isHostedMode()) {
      const db = getFomoServiceClient();
      if (db) backend = new SupabaseLinkCodeBackend(db);
      else {
        console.warn(
          '[TgBot] Hosted mode without a Supabase service client — link codes will not survive a restart.',
        );
      }
    }
    service = new LinkCodeService(backend);
  }
  return service;
}

/** Test seam. */
export function resetLinkCodeService(): void {
  service = null;
}
