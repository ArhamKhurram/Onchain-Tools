import type { StateCreator } from 'zustand';
import type { Room, AppConfig } from '../../types';
import type { AppState } from '../appStore';
import { isDemoMode, createDemoOverrides } from '../../demo/demoStore';
import { apiFetch, API_BASE, MAX_PANES, savePaneRoomIds } from '../appStore.helpers';

export interface ConfigSlice {
  config: AppConfig | null;
  configModalOpen: boolean;
  configModalTab: 'channels' | 'users' | 'filter' | 'keywords' | 'global' | null;
  editingRoom: Room | null;

  importSettings: (raw: unknown) => Promise<{ success: boolean; error?: string }>;
  fetchConfig: () => Promise<void>;
  updateConfig: (data: Partial<Pick<AppConfig, 'globalHighlightedUsers' | 'contractDetection' | 'guildColors' | 'dmColors' | 'telegramColors' | 'enabledGuilds' | 'evmAddressColor' | 'solAddressColor' | 'openInDiscordApp' | 'openInTelegramApp' | 'hiddenUsers' | 'messageSounds' | 'soundSettings' | 'channelSounds' | 'pushover' | 'missedRunner' | 'contractLinkTemplates' | 'contractClickAction' | 'showFullContractAddress' | 'autoOpenHighlightedContracts' | 'signalConvergenceWindowMinutes' | 'globalKeywordPatterns' | 'keywordAlertsEnabled' | 'desktopNotifications' | 'toastAlertsEnabled' | 'toastPosition' | 'mentionsUserEnabled' | 'mentionsRoleEnabled' | 'mentionsHereEnabled' | 'mentionsEveryoneEnabled' | 'badgeClickAction' | 'chattingEnabled' | 'messageDisplay' | 'compactModeAvatars' | 'roleColors' | 'mobileZoomScale' | 'splitLayout' | 'seenAnnouncements' | 'discordProxyUrl' | 'workspaceLayout' | 'discordBotDm'>>) => Promise<void>;
  hideUser: (guildId: string | null, channelId: string, userId: string, displayName: string) => Promise<void>;
  unhideUser: (guildId: string | null, channelId: string, userId: string) => Promise<void>;
  openConfigModal: (room?: Room, tab?: 'channels' | 'users' | 'filter' | 'keywords' | 'global') => void;
  closeConfigModal: () => void;
}

export const createConfigSlice: StateCreator<AppState, [], [], ConfigSlice> = (set, get) => {
  const demo = isDemoMode ? createDemoOverrides(set as any, get as any) : null;

  return {
    config: null,
    configModalOpen: false,
    configModalTab: null,
    editingRoom: null,

    importSettings: async (raw) => {
      try {
        if (!raw || typeof raw !== 'object') {
          return { success: false, error: 'Invalid settings file.' };
        }

        // Support both the sanitized export ({ config, rooms }) and a raw local
        // backend/data/config.json (flat AppConfig with discordTokens + rooms).
        const data = raw as Record<string, any>;
        let configPayload: Record<string, any>;
        let roomsPayload: unknown;
        let tokens: unknown[] = [];

        if (data.config && typeof data.config === 'object') {
          configPayload = data.config;
          roomsPayload = Array.isArray(data.rooms) ? data.rooms : undefined;
          if (Array.isArray(data.config.discordTokens)) tokens = data.config.discordTokens;
        } else {
          const { rooms, discordTokens, ...rest } = data;
          configPayload = rest;
          roomsPayload = Array.isArray(rooms) ? rooms : undefined;
          if (Array.isArray(discordTokens)) tokens = discordTokens;
        }

        const res = await apiFetch(`${API_BASE}/config/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: configPayload, rooms: roomsPayload }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { success: false, error: err.error || 'Failed to import settings.' };
        }

        const validTokens = tokens
          .map((t) => (typeof t === 'string' ? t.trim() : ''))
          .filter(Boolean);

        if (validTokens.length > 0) {
          const tokenResult = await get().submitToken(validTokens.join(','));
          await get().fetchConfig();
          await get().fetchRooms();
          if (!tokenResult.success) {
            // Settings imported, but the token didn't connect. Keep the user on
            // the setup screen (with a clear error) rather than silently entering.
            return {
              success: false,
              error:
                tokenResult.error ??
                'Settings imported, but the Discord token could not connect. Enter a token or continue without one.',
            };
          }
          await get().checkAuth();
          return { success: true };
        }

        // No token in the file: enter the app in preview so imported settings show.
        set({ previewMode: true });
        await get().fetchConfig();
        await get().fetchRooms();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message ?? 'Failed to import settings.' };
      }
    },

    fetchConfig: async () => {
      if (demo) return demo.fetchConfig();
      try {
        const res = await apiFetch(`${API_BASE}/config`);
        if (!res.ok) return;
        const config: AppConfig = await res.json();
        set((state) => {
          // Hydrate the split layout from the server config once on startup. This
          // is the durable source of truth (localStorage is lost on desktop since
          // the app runs on a random port each launch → a fresh origin).
          if (state._layoutHydrated) return { config };
          const patch: Partial<AppState> = { config, _layoutHydrated: true };
          if (Array.isArray(config.paneRoomIds) && config.paneRoomIds.length > 0) {
            const panes = config.paneRoomIds.slice(0, MAX_PANES);
            savePaneRoomIds(panes);
            patch.paneRoomIds = panes;
            patch.activeRoomId = panes[0] ?? state.activeRoomId;
            patch.paneLocks = Array.isArray(config.paneLocks) ? config.paneLocks.slice(0, panes.length) : [];
          }
          if (typeof config.gridMirror === 'boolean') patch.gridMirror = config.gridMirror;
          return patch;
        });
      } catch {}
    },

    updateConfig: async (data) => {
      if (demo) return demo.updateConfig(data);
      const res = await apiFetch(`${API_BASE}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(errBody || `Failed to save settings (${res.status})`);
      }
      const config: AppConfig = await res.json();
      set((state) => (state._layoutHydrated ? { config } : { config, _layoutHydrated: true }));
    },

    hideUser: async (guildId, channelId, userId, displayName) => {
      if (demo) return demo.hideUser(guildId, channelId, userId, displayName);
      const config = get().config;
      if (!config) return;
      const key = `${guildId ?? 'null'}:${channelId}`;
      const current = config.hiddenUsers?.[key] ?? [];
      if (current.some((e) => e.userId === userId)) return;
      const hiddenUsers = { ...config.hiddenUsers, [key]: [...current, { userId, displayName }] };
      await get().updateConfig({ hiddenUsers });
    },

    unhideUser: async (guildId, channelId, userId) => {
      if (demo) return demo.unhideUser(guildId, channelId, userId);
      const config = get().config;
      if (!config) return;
      const key = `${guildId ?? 'null'}:${channelId}`;
      const current = config.hiddenUsers?.[key] ?? [];
      const filtered = current.filter((e) => e.userId !== userId);
      const hiddenUsers = { ...config.hiddenUsers };
      if (filtered.length === 0) {
        delete hiddenUsers[key];
      } else {
        hiddenUsers[key] = filtered;
      }
      await get().updateConfig({ hiddenUsers });
    },

    openConfigModal: (room, tab) => set({ configModalOpen: true, editingRoom: room ?? null, configModalTab: tab ?? null }),
    closeConfigModal: () => set({ configModalOpen: false, editingRoom: null, configModalTab: null }),
  };
};
