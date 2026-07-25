import type { StateCreator } from 'zustand';
import type { FomoTrade, FomoTradeEvent } from '../../types/fomo';
import type { AppState } from '../appStore';

// Session-live FOMO trade feed; there is no historical fetch endpoint yet, so
// we only keep the most recent trades that arrive while connected.
const MAX_FOMO_TRADES = 100;

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
      const entry: FomoTrade = {
        ...trade,
        receivedAt: Date.now(),
        key: `fomo-${++fomoTradeSeq}`,
      };
      const updated = [entry, ...state.fomoTrades];
      if (updated.length > MAX_FOMO_TRADES) updated.length = MAX_FOMO_TRADES;
      return { fomoTrades: updated };
    });
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
