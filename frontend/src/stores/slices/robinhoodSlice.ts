import type { StateCreator } from 'zustand';
import type { RobinhoodFill, RobinhoodFillEntry, RobinhoodTapeResponse } from '../../types/robinhood';
import type { AppState } from '../appStore';
import { apiFetch, API_BASE } from '../appStore.helpers';

// Robinhood Chain (4663) fills from robinhoodtrenches. A separate, labelled
// source — deliberately its own slice rather than merged into fomoTrades, so
// nothing in the console can render a Robinhood Chain fill as a fomo.family
// trade or silently widen this source's scope.

const MAX_ROBINHOOD_FILLS = 300;

let fillSeq = 0;

export interface RobinhoodSlice {
  robinhoodFills: RobinhoodFillEntry[];
  /** null until the first seed attempt resolves; false when the source is down. */
  robinhoodAvailable: boolean | null;

  addRobinhoodFill: (fill: RobinhoodFill) => void;
  loadRobinhoodTape: () => Promise<void>;
  clearRobinhoodFills: () => void;
}

function toEntry(fill: RobinhoodFill): RobinhoodFillEntry {
  return { ...fill, receivedAt: Date.now(), key: `rh-${fill.id}-${++fillSeq}` };
}

export const createRobinhoodSlice: StateCreator<AppState, [], [], RobinhoodSlice> = (set) => ({
  robinhoodFills: [],
  robinhoodAvailable: null,

  addRobinhoodFill: (fill) => {
    set((state) => {
      // The WS frame can race the REST seed, and the upstream id is globally
      // unique, so dedupe on it rather than trusting arrival order.
      if (state.robinhoodFills.some((f) => f.id === fill.id)) return {};
      const updated = [toEntry(fill), ...state.robinhoodFills];
      if (updated.length > MAX_ROBINHOOD_FILLS) updated.length = MAX_ROBINHOOD_FILLS;
      return { robinhoodFills: updated, robinhoodAvailable: true };
    });
  },

  loadRobinhoodTape: async () => {
    try {
      const res = await apiFetch(`${API_BASE}/robinhood/tape?limit=150`);
      if (!res.ok) {
        set({ robinhoodAvailable: false });
        return;
      }
      const data = (await res.json()) as RobinhoodTapeResponse;
      const fills = Array.isArray(data.fills) ? data.fills : [];
      set((state) => {
        const seen = new Set(state.robinhoodFills.map((f) => f.id));
        const merged = [...state.robinhoodFills, ...fills.filter((f) => !seen.has(f.id)).map(toEntry)]
          .sort((a, b) => b.id - a.id);
        if (merged.length > MAX_ROBINHOOD_FILLS) merged.length = MAX_ROBINHOOD_FILLS;
        return { robinhoodFills: merged, robinhoodAvailable: data.available !== false };
      });
    } catch {
      // Third-party source: a failed seed is a degraded panel, never a boot error.
      set({ robinhoodAvailable: false });
    }
  },

  clearRobinhoodFills: () => set({ robinhoodFills: [] }),
});
