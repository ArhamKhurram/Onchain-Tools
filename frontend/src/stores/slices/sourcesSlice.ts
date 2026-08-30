import type { StateCreator } from 'zustand';
import type { GuildInfo, DMChannel, TelegramChatInfo } from '../../types';
import type { AppState } from '../appStore';
import { getClientGatewayManager, isClientGatewayMode } from '../../discord/clientGateway';
import { apiFetch, API_BASE } from '../appStore.helpers';

export interface SourcesSlice {
  guilds: GuildInfo[];
  dmChannels: DMChannel[];
  telegramChats: TelegramChatInfo[];

  fetchGuilds: () => Promise<void>;
  fetchDMChannels: () => Promise<void>;
  fetchTelegramChats: () => Promise<void>;
  telegramAuthStart: (apiId: string, apiHash: string, phoneNumber: string) => Promise<{ success: boolean; error?: string; needs2FA?: boolean }>;
  telegramAuthVerify: (phoneCode: string, password?: string) => Promise<{ success: boolean; error?: string; needs2FA?: boolean }>;
  telegramAuth2FA: (password: string) => Promise<{ success: boolean; error?: string }>;
  telegramDisconnect: () => Promise<{ success: boolean; error?: string }>;
}

export const createSourcesSlice: StateCreator<AppState, [], [], SourcesSlice> = (set, get) => {
  return {
    guilds: [],
    dmChannels: [],
    telegramChats: [],

    fetchGuilds: async () => {
      if (isClientGatewayMode()) {
        const gw = getClientGatewayManager();
        if (gw) set({ guilds: gw.getGuilds() });
        return;
      }
      try {
        const res = await apiFetch(`${API_BASE}/guilds`);
        if (!res.ok) return;
        const guilds: GuildInfo[] = await res.json();
        set({ guilds });
      } catch {}
    },

    fetchDMChannels: async () => {
      if (isClientGatewayMode()) {
        const gw = getClientGatewayManager();
        if (gw) set({ dmChannels: gw.getDMChannels() });
        return;
      }
      try {
        const res = await apiFetch(`${API_BASE}/dm-channels`);
        if (!res.ok) return;
        const dmChannels: DMChannel[] = await res.json();
        set({ dmChannels });
      } catch {}
    },

    fetchTelegramChats: async () => {
      try {
        const res = await apiFetch(`${API_BASE}/telegram/chats`);
        if (!res.ok) return;
        const chats: TelegramChatInfo[] = await res.json();
        set({ telegramChats: chats });
      } catch {}
    },

    telegramAuthStart: async (apiId, apiHash, phoneNumber) => {
      try {
        const res = await apiFetch(`${API_BASE}/auth/telegram/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiId, apiHash, phoneNumber }),
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error };
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    telegramAuthVerify: async (phoneCode, password) => {
      try {
        const res = await apiFetch(`${API_BASE}/auth/telegram/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneCode, password }),
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error };
        if (data.needs2FA) return { success: false, needs2FA: true };
        await get().checkAuth();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    telegramAuth2FA: async (password) => {
      try {
        const res = await apiFetch(`${API_BASE}/auth/telegram/2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error };
        await get().checkAuth();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    telegramDisconnect: async () => {
      try {
        const res = await apiFetch(`${API_BASE}/auth/telegram/disconnect`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error };
        set({ telegramChats: [] });
        await get().checkAuth();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  };
};
