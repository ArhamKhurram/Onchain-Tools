import type { StateCreator } from 'zustand';
import type { AppState } from '../appStore';
import type { PumpCalloutEvent, PumpCalloutFeedEntry } from '../../types/pumpfun';

// Live pump.fun callouts from the callers this user follows.
//
// SESSION-ONLY, deliberately. Unlike FOMO trades there is no per-user callout
// history to replay: the backend persists callouts into
// pump_callout_observations for the global Top Callers board, and that table
// carries no coin, no market cap and no thesis — nothing a feed row needs. So
// this fills from the `pump_callout` WS frame and starts empty on reload, and
// the feed's empty state says exactly that rather than implying a gap.
//
// Kept as its OWN slice rather than folded into fomoSlice: FOMO trades and pump
// callouts are independent signals (repo rule) and only share a screen shape.

const MAX_PUMP_CALLOUTS = 300;

let pumpCalloutSeq = 0;

export interface PumpCalloutsSlice {
  pumpCallouts: PumpCalloutFeedEntry[];
  addPumpCallout: (callout: PumpCalloutEvent) => void;
  clearPumpCallouts: () => void;
}

export const createPumpCalloutsSlice: StateCreator<AppState, [], [], PumpCalloutsSlice> = (set) => ({
  pumpCallouts: [],

  addPumpCallout: (callout) => {
    set((state) => {
      // The poller dedupes by calloutId against a persisted cursor, but a
      // reconnect can re-deliver the tail of a batch — so drop anything already
      // on screen rather than showing the same call twice.
      if (state.pumpCallouts.some((c) => c.calloutId === callout.calloutId)) return {};

      // createdAt is the caller's own post time when pump supplies it; arrival
      // is the honest fallback (the poller pushes within ~12s either way).
      const receivedAt = Date.now();
      const entry: PumpCalloutFeedEntry = {
        ...callout,
        // Pin the key so a frame from a backend that predates the field still
        // renders "—" through the same path as an honest null.
        maxMultiplier: callout.maxMultiplier ?? null,
        occurredAt: typeof callout.createdAt === 'number' ? callout.createdAt : receivedAt,
        receivedAt,
        key: `pump-callout-${++pumpCalloutSeq}`,
      };
      const updated = [entry, ...state.pumpCallouts];
      if (updated.length > MAX_PUMP_CALLOUTS) updated.length = MAX_PUMP_CALLOUTS;
      return { pumpCallouts: updated };
    });
  },

  clearPumpCallouts: () => set({ pumpCallouts: [] }),
});
