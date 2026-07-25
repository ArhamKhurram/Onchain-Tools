import { BaseRepo, throwIfError } from './client.js';

export class UserCacheRepo extends BaseRepo {
  async cacheUserName(userId: string, discordUserId: string, displayName: string): Promise<void> {
    const { data } = await this.supabase
      .from('user_configs')
      .select('settings')
      .eq('user_id', userId)
      .single();

    const settings = data?.settings ?? {};
    const cache = settings.userNameCache ?? {};
    if (cache[discordUserId] === displayName) return;

    cache[discordUserId] = displayName;
    settings.userNameCache = cache;

    const result = await this.supabase
      .from('user_configs')
      .upsert({ user_id: userId, settings }, { onConflict: 'user_id' });
    throwIfError(result, 'Failed to cache user name');
    this.invalidateUser(userId);
  }
}
