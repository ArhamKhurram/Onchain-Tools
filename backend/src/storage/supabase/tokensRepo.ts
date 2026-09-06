import { encryptToken, decryptToken, maskToken } from '../../auth/encryption.js';
import { BaseRepo, throwIfError } from './client.js';

export class TokensRepo extends BaseRepo {
  // Loaded on every getConfig cache miss, so it inherits the ingest path's
  // burstiness — hence `cached()` (single-flight) rather than get/set. The
  // empty result is cached too: token-less users are common in hosted mode and
  // the previous early return meant they re-queried on every miss.
  async getTokens(userId: string): Promise<string[]> {
    return this.cached(`${userId}:tokens`, async () => {
      const result = await this.supabase
        .from('discord_tokens')
        .select('encrypted_token, token_iv, token_tag, position')
        .eq('user_id', userId)
        .order('position');

      throwIfError(result, 'Failed to fetch tokens');
      if (!result.data || result.data.length === 0) return [];

      return result.data.map((row) => decryptToken(row.encrypted_token, row.token_iv, row.token_tag));
    });
  }

  async setTokens(userId: string, tokens: string[]): Promise<void> {
    const delResult = await this.supabase.from('discord_tokens').delete().eq('user_id', userId);
    throwIfError(delResult, 'Failed to delete existing tokens');

    // Clearing tokens must invalidate too — now that the empty result is
    // cached, an early return here would serve the deleted tokens for a TTL.
    if (tokens.length === 0) {
      this.invalidateUser(userId);
      return;
    }

    const rows = tokens.map((token, i) => {
      const { encrypted, iv, tag } = encryptToken(token);
      return {
        user_id: userId,
        encrypted_token: encrypted,
        token_iv: iv,
        token_tag: tag,
        token_mask: maskToken(token),
        position: i,
      };
    });

    const insResult = await this.supabase.from('discord_tokens').insert(rows);
    throwIfError(insResult, 'Failed to store tokens');
    this.invalidateUser(userId);
  }
}
