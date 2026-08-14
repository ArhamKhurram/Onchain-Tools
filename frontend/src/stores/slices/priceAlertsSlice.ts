import type { StateCreator } from 'zustand';
import type { AppState } from '../appStore';

/**
 * Price-alert refresh signal. The Alerts panel keeps its rows page-local (like
 * Journal and Sniper); the store only carries the "something crossed"
 * timestamp that the `price_alert` WS frame bumps, so an open panel moves the
 * fired row out of "armed" without polling for it.
 */
export interface PriceAlertsSlice {
  /** Epoch ms of the last price_alert WS frame (0 = none this session). */
  priceAlertLastEventAt: number;
  bumpPriceAlertRefresh: () => void;
}

export const createPriceAlertsSlice: StateCreator<AppState, [], [], PriceAlertsSlice> = (set) => ({
  priceAlertLastEventAt: 0,
  bumpPriceAlertRefresh: () => set({ priceAlertLastEventAt: Date.now() }),
});
