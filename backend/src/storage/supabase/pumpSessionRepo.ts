// Hosted-mode store for the user's pump.fun session bearer.
//
// A near-verbatim sibling of TokensRepo: same AES-256-GCM columns
// (encrypted_token, token_iv, token_tag, token_mask), same encrypt-on-write /
// decrypt-on-read discipline, same per-user cache line. The ONE structural
// difference is cardinality — a user has many Discord tokens (positional rows)
// but exactly ONE pump session — so this is an upsert of a single row keyed by
// user_id, not a delete-then-insert of an ordered list.
//
// SECURITY: the plaintext bearer exists only transiently, inside encryptToken()
// on write and as the decryptToken() return on read. It is never selected back
// as plaintext (the table stores only ciphertext + iv + tag + a mask), never
// logged, and never returned by any route. `token_mask` is stored purely so an
// operator inspecting the row sees a masked stub, never the credential.

import { encryptToken, decryptToken, maskToken } from '../../auth/encryption.js';
import type { PumpSession } from '../interface.js';
import { BaseRepo, throwIfError } from './client.js';

export class PumpSessionRepo extends BaseRepo {
  async getPumpSession(userId: string): Promise<PumpSession | null> {
    const cacheKey = `${userId}:pumpSession`;
    const cached = this.getCached<PumpSession | null>(cacheKey);
    // `undefined` = cache miss; `null` = cached "not connected". Distinguish them
    // so a genuine not-connected result is served from cache without re-querying.
    if (cached !== undefined) return cached;

    const result = await this.supabase
      .from('pump_sessions')
      .select('encrypted_token, token_iv, token_tag, updated_at')
      .eq('user_id', userId)
      .maybeSingle();

    throwIfError(result, 'Failed to fetch pump session');
    if (!result.data) {
      this.setCache(cacheKey, null);
      return null;
    }

    const row = result.data as {
      encrypted_token: string;
      token_iv: string;
      token_tag: string;
      updated_at: string | null;
    };
    const session: PumpSession = {
      token: decryptToken(row.encrypted_token, row.token_iv, row.token_tag),
      updatedAt: row.updated_at ?? new Date().toISOString(),
    };
    this.setCache(cacheKey, session);
    return session;
  }

  async setPumpSession(userId: string, token: string | null): Promise<void> {
    if (token === null || token === '') {
      const delResult = await this.supabase.from('pump_sessions').delete().eq('user_id', userId);
      throwIfError(delResult, 'Failed to clear pump session');
      this.invalidateUser(userId);
      return;
    }

    const { encrypted, iv, tag } = encryptToken(token);
    const upsertResult = await this.supabase.from('pump_sessions').upsert(
      {
        user_id: userId,
        encrypted_token: encrypted,
        token_iv: iv,
        token_tag: tag,
        token_mask: maskToken(token),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    throwIfError(upsertResult, 'Failed to store pump session');
    this.invalidateUser(userId);
  }
}
