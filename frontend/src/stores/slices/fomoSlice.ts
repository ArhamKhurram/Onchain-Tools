import type { StateCreator } from 'zustand';
import type { FomoTrade, FomoTradeEvent, FomoTradeHistoryEntry } from '../../types/fomo';
import type { AppState } from '../appStore';
import { apiFetch, API_BASE } from '../appStore.helpers';

// Holds the replayed history window plus whatever has arrived live since, so the
// cap has to clear a busy day rather than just a session.
const MAX_FOMO_TRADES = 500;
const HISTORY_HOURS = 24;

let fomoTradeSeq = 0;

export interface FomoSlice {
  connected: boolean;
  focusFilter: { guildId: string | null; channelId: string; guildName: string | null; channelName: string } | null;
  sidebarCollapsed: boolean;
  gatewayAuthError: string | null;
  gatewayBlocked: boolean;
  previewMode: boolean;
  fomoTrades: FomoTrade[];

  addFomoTrade: (trade: FomoTradeEvent) => void;
  loadFomoTradeHistory: () => Promise<void>;
  clearFomoTrades: () => void;
  setPreviewMode: (value: boolean) => void;
  setGatewayAuthError: (error: string | null, blocked?: boolean) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setConnected: (connected: boolean) => void;
  setFocusFilter: (filter: FomoSlice['focusFilter']) => void;
  clearFocusFilter: () => void;
}

export const createFomoSlice: StateCreator<AppState, [], [], FomoSlice> = (set) => ({
  connected: false,
  focusFilter: null,
  sidebarCollapsed: false,
  gatewayAuthError: null,
  gatewayBlocked: false,
  previewMode: false,
  fomoTrades: [],

  addFomoTrade: (trade) => {
    set((state) => {
      const now = Date.now();
      // The poller pushes within seconds of the swap, so arrival is a fair stand-in
      // for trade time on live frames — history carries the real one.
      const entry: FomoTrade = {
        ...trade,
        occurredAt: now,
        receivedAt: now,
        key: `fomo-${++fomoTradeSeq}`,
      };
      // A live frame can race the history load, so drop anything already replayed.
      if (trade.tradeId && state.fomoTrades.some((t) => t.tradeId === trade.tradeId)) {
        return {};
      }
      const updated = [entry, ...state.fomoTrades];
      if (updated.length > MAX_FOMO_TRADES) updated.length = MAX_FOMO_TRADES;
      return { fomoTrades: updated };
    });
  },

  loadFomoTradeHistory: async () => {
    try {
      const res = await apiFetch(`${API_BASE}/fomo/trades?hours=${HISTORY_HOURS}`);
      // 503 = FOMO storage not configured (local mode). Not an error worth surfacing.
      if (!res.ok) return;
      const data = (await res.json()) as { trades?: FomoTradeHistoryEntry[] };
      if (!Array.isArray(data.trades) || data.trades.length === 0) return;

      const now = Date.now();
      set((state) => {
        const seen = new Set(state.fomoTrades.map((t) => t.tradeId).filter(Boolean));
        // Anything that arrived live while this request was in flight stays put;
        // history only fills in behind it.
        const replayed: FomoTrade[] = data.trades!
          .filter((t) => !t.tradeId || !seen.has(t.tradeId))
          .map((t) => ({ ...t, receivedAt: now, key: `fomo-${++fomoTradeSeq}` }));

        const merged = [...state.fomoTrades, ...replayed].sort(
          (a, b) => b.occurredAt - a.occurredAt,
        );
        if (merged.length > MAX_FOMO_TRADES) merged.length = MAX_FOMO_TRADES;
        return { fomoTrades: merged };
      });
    } catch {
      // The live feed still works without history; never block boot on this.
    }
  },

  clearFomoTrades: () => set({ fomoTrades: [] }),

  setPreviewMode: (value) => set({ previewMode: value }),

  setGatewayAuthError: (error, blocked) => set({ gatewayAuthError: error, gatewayBlocked: error ? (blocked ?? false) : false }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setConnected: (connected) => set({ connected }),
  setFocusFilter: (filter) => set({ focusFilter: filter }),
  clearFocusFilter: () => set({ focusFilter: null }),
});
