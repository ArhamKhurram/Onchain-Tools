import type { AppConfig } from '../../discord/types.js';
import { BaseRepo, throwIfError } from './client.js';
import { DEFAULT_SETTINGS, highlightRowsToApp, keywordRowsToApp } from './mappers.js';
import type { RoomsRepo } from './roomsRepo.js';
import type { TokensRepo } from './tokensRepo.js';
import type { TelegramRepo } from './telegramRepo.js';

export class ConfigRepo extends BaseRepo {
  rooms!: RoomsRepo;
  tokens!: TokensRepo;
  telegram!: TelegramRepo;

  async getConfig(userId: string): Promise<AppConfig> {
    const cacheKey = `${userId}:config`;
    const cached = this.getCached<AppConfig>(cacheKey);
    if (cached) return cached;

    const { data } = await this.supabase
      .from('user_configs')
      .select('settings')
      .eq('user_id', userId)
      .single();

    const settings = data?.settings ?? {};
    delete settings.telegramApiId;
    delete settings.telegramApiHash;
    delete settings.telegramSessions;
    delete settings.globalHighlightedUsers;
    delete settings.globalKeywordPatterns;
    const merged = {
      ...DEFAULT_SETTINGS,
      ...settings,
      pushover: {
        ...DEFAULT_SETTINGS.pushover,
        ...(settings.pushover ?? {}),
        triggers: {
          ...DEFAULT_SETTINGS.pushover.triggers,
          ...(settings.pushover?.triggers ?? {}),
        },
        filters: {
          ...DEFAULT_SETTINGS.pushover.filters,
          ...(settings.pushover?.filters ?? {}),
        },
      },
      missedRunner: {
        ...DEFAULT_SETTINGS.missedRunner,
        ...(settings.missedRunner ?? {}),
      },
    };

    const tokens = await this.tokens.getTokens(userId);
    const rooms = await this.rooms.getRooms(userId);
    const [globalHighlights, globalKeywords] = await Promise.all([
      this.rooms.loadHighlightRows(userId).then((rows) => rows.filter((row) => row.room_id === null)),
      this.rooms.loadKeywordRows(userId).then((rows) => rows.filter((row) => row.room_id === null)),
    ]);
    const telegramCreds = await this.telegram.getTelegramApiCredentials(userId);
    const telegramSessions = await this.telegram.getTelegramSessions(userId);

    const config = {
      ...merged,
      globalHighlightedUsers: highlightRowsToApp(globalHighlights).highlightedUsers,
      globalKeywordPatterns: keywordRowsToApp(globalKeywords),
      discordTokens: tokens,
      rooms,
      telegramApiId: telegramCreds?.apiId,
      telegramApiHash: telegramCreds?.apiHash,
      telegramSessions,
    } as AppConfig;
    this.setCache(cacheKey, config);
    return config;
  }

  async updateConfig(userId: string, partial: Partial<AppConfig>): Promise<AppConfig> {
    const {
      discordTokens: _t,
      rooms: _r,
      telegramApiId,
      telegramApiHash,
      telegramSessions,
      globalHighlightedUsers,
      globalKeywordPatterns,
      ...settingsUpdate
    } = partial as any;

    if (globalHighlightedUsers !== undefined) {
      await this.rooms.syncHighlights(userId, null, globalHighlightedUsers);
    }

    if (globalKeywordPatterns !== undefined) {
      await this.rooms.syncKeywords(userId, null, globalKeywordPatterns);
    }

    if (telegramApiId !== undefined || telegramApiHash !== undefined) {
      await this.telegram.setTelegramApiCredentials(userId, telegramApiId, telegramApiHash);
    }

    if (telegramSessions !== undefined) {
      await this.telegram.setTelegramSessions(userId, telegramSessions);
    }

    const { data: existing } = await this.supabase
      .from('user_configs')
      .select('settings')
      .eq('user_id', userId)
      .single();

    const currentSettings = existing?.settings ?? {};
    const newSettings = { ...currentSettings, ...settingsUpdate };

    // Scrub any leftover plaintext telegram fields from the JSON blob
    delete newSettings.telegramApiId;
    delete newSettings.telegramApiHash;
    delete newSettings.telegramSessions;
    delete newSettings.globalHighlightedUsers;
    delete newSettings.globalKeywordPatterns;

    const result = await this.supabase
      .from('user_configs')
      .upsert({ user_id: userId, settings: newSettings }, { onConflict: 'user_id' });
    throwIfError(result, 'Failed to update config');

    this.invalidateUser(userId);
    return this.getConfig(userId);
  }
}
