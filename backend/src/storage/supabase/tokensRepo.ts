import { encryptToken, decryptToken, maskToken } from '../../auth/encryption.js';
import { BaseRepo, throwIfError } from './client.js';

export class TokensRepo extends BaseRepo {
  async getTokens(userId: string): Promise<string[]> {
    const cacheKey = `${userId}:tokens`;
    const cached = this.getCached<string[]>(cacheKey);
    if (cached) return cached;

    const result = await this.supabase
      .from('discord_tokens')
      .select('encrypted_token, token_iv, token_tag, position')
      .eq('user_id', userId)
      .order('position');

    throwIfError(result, 'Failed to fetch tokens');
    if (!result.data || result.data.length === 0) return [];

    const tokens = result.data.map((row) => decryptToken(row.encrypted_token, row.token_iv, row.token_tag));
    this.setCache(cacheKey, tokens);
    return tokens;
  }

  async setTokens(userId: string, tokens: string[]): Promise<void> {
    const delResult = await this.supabase.from('discord_tokens').delete().eq('user_id', userId);
    throwIfError(delResult, 'Failed to delete existing tokens');

    if (tokens.length === 0) return;

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
