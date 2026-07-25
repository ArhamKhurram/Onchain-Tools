import type { StateCreator } from 'zustand';
import type { AuthStatus, MaskedToken } from '../../types';
import type { AppState } from '../appStore';
import { isDemoMode, createDemoOverrides } from '../../demo/demoStore';
import { markTokenEverConfigured } from '../../utils/tokenState';
import {
  connectClientGateway,
  disconnectClientGateway,
  getClientGatewayManager,
  isClientGatewayMode,
} from '../../discord/clientGateway';
import {
  clearLocalDiscordTokens,
  getLocalDiscordTokens,
  hasLocalDiscordTokens,
  maskDiscordToken,
  setLocalDiscordTokens,
} from '../../discord/tokenStore';
import { apiFetch, API_BASE } from '../appStore.helpers';

export interface AuthSlice {
  authStatus: AuthStatus | null;
  authLoading: boolean;
  maskedTokens: MaskedToken[];

  checkAuth: () => Promise<void>;
  submitToken: (token: string) => Promise<{ success: boolean; error?: string }>;
  fetchMaskedTokens: () => Promise<void>;
  addToken: (token: string) => Promise<{ success: boolean; error?: string }>;
  removeToken: (index: number) => Promise<{ success: boolean; error?: string }>;
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set, get) => {
  const demo = isDemoMode ? createDemoOverrides(set as any, get as any) : null;

  return {
    authStatus: null,
    authLoading: true,
    maskedTokens: [],

    checkAuth: async () => {
      if (demo) return demo.checkAuth();
      try {
        set({ authLoading: true });
        const res = await apiFetch(`${API_BASE}/auth/status`);
        if (!res.ok) {
          set({ authStatus: null, authLoading: false });
          return;
        }
        const status: AuthStatus = await res.json();
        if (isClientGatewayMode()) {
          status.clientGateway = true;
          status.configured = hasLocalDiscordTokens();
          status.connected = status.configured && getClientGatewayManager() !== null;
        }
        if (status?.configured) {
          markTokenEverConfigured();
        }
        set({ authStatus: status, authLoading: false });
      } catch {
        set({ authStatus: null, authLoading: false });
      }
    },

    submitToken: async (token: string) => {
      if (demo) return demo.submitToken();
      if (isClientGatewayMode()) {
        try {
          const tokens = token.includes(',')
            ? token.split(',').map((t) => t.trim()).filter(Boolean)
            : [token.trim()];
          if (tokens.length === 0) {
            return { success: false, error: 'A valid Discord token is required.' };
          }
          setLocalDiscordTokens(tokens);
          connectClientGateway(tokens);
          markTokenEverConfigured();
          await get().fetchMaskedTokens();
          set({ authStatus: { configured: true, connected: false, clientGateway: true } });
          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }
      try {
        const res = await apiFetch(`${API_BASE}/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error };
        markTokenEverConfigured();
        set({ authStatus: { configured: true, connected: true } });
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    fetchMaskedTokens: async () => {
      if (demo) return demo.fetchMaskedTokens();
      if (isClientGatewayMode()) {
        const tokens = getLocalDiscordTokens();
        const gw = getClientGatewayManager();
        const invalidIndices = new Set(gw?.getInvalidTokenIndices() ?? []);
        set({
          maskedTokens: tokens.map((t, index) => ({
            index,
            masked: maskDiscordToken(t),
            invalid: invalidIndices.has(index),
          })),
        });
        return;
      }
      try {
        const res = await apiFetch(`${API_BASE}/auth/tokens`);
        if (!res.ok) return;
        const data = await res.json();
        set({ maskedTokens: data.tokens ?? [] });
      } catch {}
    },

    addToken: async (token: string) => {
      if (demo) return demo.addToken();
      if (isClientGatewayMode()) {
        try {
          const trimmed = token.trim();
          if (!trimmed) return { success: false, error: 'A valid Discord token is required.' };
          const existing = getLocalDiscordTokens();
          if (existing.includes(trimmed)) {
            return { success: false, error: 'This token is already configured.' };
          }
          const updated = [...existing, trimmed];
          setLocalDiscordTokens(updated);
          connectClientGateway(updated);
          markTokenEverConfigured();
          await get().fetchMaskedTokens();
          set({ authStatus: { configured: true, connected: false, clientGateway: true } });
          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }
      try {
        const res = await apiFetch(`${API_BASE}/auth/tokens/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error };
        markTokenEverConfigured();
        await get().fetchMaskedTokens();
        set({ authStatus: { configured: true, connected: true } });
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    removeToken: async (index: number) => {
      if (demo) return demo.removeToken();
      if (isClientGatewayMode()) {
        try {
          const existing = getLocalDiscordTokens();
          if (index < 0 || index >= existing.length) {
            return { success: false, error: 'Invalid token index.' };
          }
          const updated = existing.filter((_, i) => i !== index);
          if (updated.length === 0) {
            clearLocalDiscordTokens();
            disconnectClientGateway();
          } else {
            setLocalDiscordTokens(updated);
            connectClientGateway(updated);
          }
          await get().fetchMaskedTokens();
          await get().checkAuth();
          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }
      try {
        const res = await apiFetch(`${API_BASE}/auth/tokens/${index}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error };
        await get().fetchMaskedTokens();
        await get().checkAuth();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  };
};
