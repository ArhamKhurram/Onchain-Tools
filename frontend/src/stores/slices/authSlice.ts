import type { StateCreator } from 'zustand';
import type { AuthStatus, MaskedToken } from '../../types';
import type { AppState } from '../appStore';
import { markTokenEverConfigured } from '../../utils/tokenState';
import { resolveAuthStatus } from '../authStatusResolve';
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
  /**
   * Whether the last backend call reached the server at all. null = not yet
   * attempted. This is deliberately distinct from "not authenticated": a CORS
   * rejection or a dead backend must be visible, not silently rendered as an
   * empty console. See BackendUnreachableBanner.
   */
  backendReachable: boolean | null;

  checkAuth: () => Promise<void>;
  submitToken: (token: string) => Promise<{ success: boolean; error?: string }>;
  fetchMaskedTokens: () => Promise<void>;
  addToken: (token: string) => Promise<{ success: boolean; error?: string }>;
  removeToken: (index: number) => Promise<{ success: boolean; error?: string }>;
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set, get) => {
  return {
    authStatus: null,
    authLoading: true,
    maskedTokens: [],
    backendReachable: null,

    checkAuth: async () => {

      // The configured/connected decision lives in resolveAuthStatus (pure, and
      // unit-tested) because it is subtle: in client-gateway mode the token is
      // browser-only (ADR-002), so a failed /auth/status says nothing about
      // whether Discord is configured and must not clear it.
      const resolve = (serverStatus: AuthStatus | null): AuthStatus | null =>
        resolveAuthStatus({
          serverStatus,
          clientGatewayMode: isClientGatewayMode(),
          hasLocalTokens: hasLocalDiscordTokens(),
          gatewayPresent: getClientGatewayManager() !== null,
        });

      try {
        set({ authLoading: true });
        const res = await apiFetch(`${API_BASE}/auth/status`);
        if (!res.ok) {
          // Reached the server; it just refused. Not an unreachable backend.
          set({ authStatus: resolve(null), authLoading: false, backendReachable: true });
          return;
        }
        const status = resolve(await res.json());
        if (status?.configured) {
          markTokenEverConfigured();
        }
        set({ authStatus: status, authLoading: false, backendReachable: true });
      } catch {
        // fetch() itself threw: DNS, offline, or — the case that cost hours — a
        // CORS rejection, which is indistinguishable from a network error here.
        set({ authStatus: resolve(null), authLoading: false, backendReachable: false });
      }
    },

    submitToken: async (token: string) => {
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
