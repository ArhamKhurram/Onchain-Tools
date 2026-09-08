import type { StateCreator } from 'zustand';
import type {
  FomoStreamTrade,
  FomoStreamTradeEntry,
  FomoStreamTapeResponse,
} from '../../types/fomoStream';
import type { AppState } from '../appStore';
import { apiFetch, API_BASE } from '../appStore.helpers';

// All-chain FOMO tape as re-broadcast by 985monitor.xyz. A separate, labelled
// source — its own slice rather than merged into fomoTrades, so nothing in the
// console can render a 985monitor row as OCT's own fomo.family trade or quietly
// widen what the fomo.family feed is claimed to cover.

const MAX_STREAM_TRADES = 300;

let tradeSeq = 0;

export interface FomoStreamSlice {
  fomoStreamTrades: FomoStreamTradeEntry[];
  /** null until the first seed attempt resolves; false when the source is down. */
  fomoStreamAvailable: boolean | null;

  addFomoStreamTrade: (trade: FomoStreamTrade) => void;
  loadFomoStreamTape: () => Promise<void>;
  clearFomoStreamTrades: () => void;
}

function toEntry(trade: FomoStreamTrade): FomoStreamTradeEntry {
  return { ...trade, receivedAt: Date.now(), key: `fs-${trade.id}-${++tradeSeq}` };
}

export const createFomoStreamSlice: StateCreator<AppState, [], [], FomoStreamSlice> = (set) => ({
  fomoStreamTrades: [],
  fomoStreamAvailable: null,

  addFomoStreamTrade: (trade) => {
    set((state) => {
      // The WS frame can race the REST seed, and the upstream key is globally
      // unique, so dedupe on it rather than trusting arrival order.
      if (state.fomoStreamTrades.some((t) => t.id === trade.id)) return {};
      const updated = [toEntry(trade), ...state.fomoStreamTrades];
      if (updated.length > MAX_STREAM_TRADES) updated.length = MAX_STREAM_TRADES;
      return { fomoStreamTrades: updated, fomoStreamAvailable: true };
    });
  },

  loadFomoStreamTape: async () => {
    try {
      const res = await apiFetch(`${API_BASE}/fomo/stream/tape?limit=150`);
      if (!res.ok) {
        set({ fomoStreamAvailable: false });
        return;
      }
      const data = (await res.json()) as FomoStreamTapeResponse;
      const trades = Array.isArray(data.trades) ? data.trades : [];
      set((state) => {
        const seen = new Set(state.fomoStreamTrades.map((t) => t.id));
        const merged = [
          ...state.fomoStreamTrades,
          ...trades.filter((t) => !seen.has(t.id)).map(toEntry),
        ].sort((a, b) => b.ts - a.ts);
        if (merged.length > MAX_STREAM_TRADES) merged.length = MAX_STREAM_TRADES;
        return { fomoStreamTrades: merged, fomoStreamAvailable: data.available !== false };
      });
    } catch {
      // Third-party source: a failed seed is a degraded panel, never a boot error.
      set({ fomoStreamAvailable: false });
    }
  },

  clearFomoStreamTrades: () => set({ fomoStreamTrades: [] }),
});
