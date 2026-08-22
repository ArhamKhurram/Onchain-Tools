import type { StateCreator } from 'zustand';
import type { AppState } from '../appStore';
import { buildPreviewSeed, resetPreviewStream } from '../../preview/previewFeed';
import { deriveAddressChains, savePaneRoomIds } from '../appStore.helpers';
import { track } from '../../lib/analytics';

// The seeded "Continue without a token" onboarding path. `previewMode` itself
// lives in fomoSlice (it predates this and gates several data loads); this slice
// owns the *seeded* variant — the one that fills the console with a flowing
// sample feed so a new user feels the product before the token ask.
//
// Kept distinct from the import-a-config path, which also flips previewMode but
// loads real (imported) data from the backend and must NOT be overwritten with
// sample data. `previewSeeded` is the discriminator AppProviders keys off.

export interface PreviewSlice {
  /** True only for the seeded demo-feed path (not config-import preview). */
  previewSeeded: boolean;

  /** Enter the seeded demo feed: fill the store with sample rooms + a live feed. */
  enterPreview: () => void;
  /** Leave the demo feed and return to the connect/token screen. */
  exitPreview: () => void;
}

export const createPreviewSlice: StateCreator<AppState, [], [], PreviewSlice> = (set) => ({
  previewSeeded: false,

  enterPreview: () => {
    const seed = buildPreviewSeed();
    resetPreviewStream();
    savePaneRoomIds(seed.paneRoomIds);
    set({
      previewMode: true,
      previewSeeded: true,
      rooms: seed.rooms,
      config: seed.config,
      guilds: seed.guilds,
      messages: seed.messages,
      contracts: seed.contracts,
      addressChains: deriveAddressChains(seed.contracts),
      activeRoomId: seed.activeRoomId,
      paneRoomIds: seed.paneRoomIds,
      activeView: 'chat',
      _layoutHydrated: true,
    });
    track('preview_entered');
  },

  exitPreview: () => {
    savePaneRoomIds([]);
    set({
      previewMode: false,
      previewSeeded: false,
      rooms: [],
      messages: {},
      contracts: [],
      addressChains: {},
      guilds: [],
      activeRoomId: null,
      paneRoomIds: [],
    });
    track('preview_to_connect_clicked');
  },
});
