import { create } from 'zustand';

interface UpdatesUiState {
  /** User opened the changelog from the header rocket. */
  manualOpen: boolean;
  openChangelog: () => void;
  closeChangelog: () => void;
}

export const useUpdatesUiStore = create<UpdatesUiState>((set) => ({
  manualOpen: false,
  openChangelog: () => set({ manualOpen: true }),
  closeChangelog: () => set({ manualOpen: false }),
}));
