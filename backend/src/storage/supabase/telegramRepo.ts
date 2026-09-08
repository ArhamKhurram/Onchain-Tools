import { encryptToken, decryptToken } from '../../auth/encryption.js';
import { BaseRepo, throwIfError } from './client.js';

export class TelegramRepo extends BaseRepo {
  async getTelegramApiCredentials(userId: string): Promise<{ apiId: string; apiHash: string } | null> {
    // getConfig fans out to this on every cache miss, so it rides the ingest
    // burst. `cached()` gives it single-flight; the negative (null) result is
    // cached as well, since users with no Telegram credentials would otherwise
    // re-query on every miss forever.
    return this.cached(`${userId}:tg_creds`, async () => {
      const { data } = await this.supabase
        .from('telegram_credentials')
        .select('encrypted_api_id, api_id_iv, api_id_tag, encrypted_api_hash, api_hash_iv, api_hash_tag')
        .eq('user_id', userId)
        .single();

      if (!data) return null;

      const apiId = decryptToken(data.encrypted_api_id, data.api_id_iv, data.api_id_tag);
      const apiHash = decryptToken(data.encrypted_api_hash, data.api_hash_iv, data.api_hash_tag);
      return { apiId, apiHash };
    });
  }

  async setTelegramApiCredentials(userId: string, apiId?: string, apiHash?: string): Promise<void> {
    if (!apiId && !apiHash) return;

    const existing = await this.getTelegramApiCredentials(userId);
    const finalApiId = apiId ?? existing?.apiId;
    const finalApiHash = apiHash ?? existing?.apiHash;

    if (!finalApiId || !finalApiHash) return;

    const encId = encryptToken(finalApiId);
    const encHash = encryptToken(finalApiHash);

    const result = await this.supabase.from('telegram_credentials').upsert({
      user_id: userId,
      encrypted_api_id: encId.encrypted,
      api_id_iv: encId.iv,
      api_id_tag: encId.tag,
      encrypted_api_hash: encHash.encrypted,
      api_hash_iv: encHash.iv,
      api_hash_tag: encHash.tag,
    }, { onConflict: 'user_id' });
    throwIfError(result, 'Failed to store Telegram API credentials');
    this.invalidateUser(userId);
  }

  async getTelegramSessions(userId: string): Promise<string[]> {
    return this.cached(`${userId}:tg_sessions`, async () => {
      const { data } = await this.supabase
        .from('telegram_sessions')
        .select('encrypted_session, session_iv, session_tag, position')
        .eq('user_id', userId)
        .order('position');

      if (!data || data.length === 0) return [];

      return data.map((row) => decryptToken(row.encrypted_session, row.session_iv, row.session_tag));
    });
  }

  async setTelegramSessions(userId: string, sessions: string[]): Promise<void> {
    const delResult = await this.supabase.from('telegram_sessions').delete().eq('user_id', userId);
    throwIfError(delResult, 'Failed to delete existing Telegram sessions');

    if (sessions.length === 0) {
      this.invalidateUser(userId);
      return;
    }

    const rows = sessions.map((session, i) => {
      const enc = encryptToken(session);
      return {
        user_id: userId,
        encrypted_session: enc.encrypted,
        session_iv: enc.iv,
        session_tag: enc.tag,
        position: i,
      };
    });

    const insResult = await this.supabase.from('telegram_sessions').insert(rows);
    throwIfError(insResult, 'Failed to store Telegram sessions');
    this.invalidateUser(userId);
  }
}
