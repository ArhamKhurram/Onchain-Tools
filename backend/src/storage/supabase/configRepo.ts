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

  /**
   * Read on every inbound message (both ingest handlers build their processor
   * context from it) as well as every alert/notify path. `cached()` rather than
   * get/set: on a cache miss this is ~8 round-trips, and without single-flight
   * a burst of messages ran one whole copy of that per message. That is what
   * drained the Supabase pool on 2026-09-06.
   */
  async getConfig(userId: string): Promise<AppConfig> {
    return this.cached(`${userId}:config`, () => this.loadConfig(userId));
  }

  private async loadConfig(userId: string): Promise<AppConfig> {
    // One concurrent stage for the five independent loads: this runs on every
    // alert/notify path behind a 10s cache, so a cache miss used to cost seven
    // sequential round-trip stages. The rooms bundle also carries the global
    // highlight/keyword rows getRooms was already fetching (its or-filter
    // includes room_id.is.null), which is what retires the two duplicate
    // whole-table reads of highlighted_users and keywords this method made.
    const [{ data }, tokens, roomsBundle, telegramCreds, telegramSessions] = await Promise.all([
      this.supabase
        .from('user_configs')
        .select('settings')
        .eq('user_id', userId)
        .single(),
      this.tokens.getTokens(userId),
      this.rooms.getRoomsBundle(userId),
      this.telegram.getTelegramApiCredentials(userId),
      this.telegram.getTelegramSessions(userId),
    ]);

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
      // Per-key merge so configs saved before a SoundType existed (e.g.
      // `revival`) still surface that type's defaults.
      soundSettings: {
        ...DEFAULT_SETTINGS.soundSettings,
        ...Object.fromEntries(
          Object.entries(settings.soundSettings ?? {}).map(([key, value]) => [
            key,
            {
              ...(DEFAULT_SETTINGS.soundSettings as Record<string, unknown>)[key] as object,
              ...(value as object),
            },
          ]),
        ),
      },
    };

    return {
      ...merged,
      globalHighlightedUsers: highlightRowsToApp(roomsBundle.globalHighlightRows).highlightedUsers,
      globalKeywordPatterns: keywordRowsToApp(roomsBundle.globalKeywordRows),
      discordTokens: tokens,
      rooms: roomsBundle.rooms,
      telegramApiId: telegramCreds?.apiId,
      telegramApiHash: telegramCreds?.apiHash,
      telegramSessions,
    } as AppConfig;
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
