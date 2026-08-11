import type { StateCreator } from 'zustand';
import type { AppState } from '../appStore';

/**
 * Trade-journal refresh signal. The Journal tab keeps its data page-local
 * (like Sniper); the store only carries the "something changed" timestamp
 * that `journal_update` / `journal_alert` WS frames bump, so an open tab
 * refetches without polling aggressively.
 */
export interface JournalSlice {
  /** Epoch ms of the last journal WS event (0 = none this session). */
  journalLastEventAt: number;
  bumpJournalRefresh: () => void;
}

export const createJournalSlice: StateCreator<AppState, [], [], JournalSlice> = (set) => ({
  journalLastEventAt: 0,
  bumpJournalRefresh: () => set({ journalLastEventAt: Date.now() }),
});
