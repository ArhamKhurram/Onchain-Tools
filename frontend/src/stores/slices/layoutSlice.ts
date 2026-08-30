import type { StateCreator } from 'zustand';
import type { AppState } from '../appStore';
import {
  apiFetch,
  API_BASE,
  MAX_PANES,
  IS_POPOUT,
  loadPaneRoomIds,
  savePaneRoomIds,
  loadLayoutEditMode,
  loadGridMirror,
  EDIT_MODE_STORAGE_KEY,
  GRID_MIRROR_STORAGE_KEY,
  pickPaneFill,
} from '../appStore.helpers';

export interface LayoutSlice {
  paneRoomIds: string[];
  paneLocks: boolean[];
  poppedOutRoomIds: string[];
  activePaneIndex: number;
  unreadCounts: Record<string, number>;
  layoutEditMode: boolean;
  gridMirror: boolean;
  _layoutHydrated: boolean;
  activeView: 'chat' | 'contracts' | 'settings' | 'profile';
  settingsSection: string | null;

  setActiveRoom: (roomId: string | null) => void;
  setPaneRoom: (index: number, roomId: string) => void;
  setActivePane: (index: number) => void;
  togglePaneLock: (index: number) => void;
  addPane: () => void;
  removePane: (index: number) => void;
  popOutPane: (index: number) => void;
  dockPopout: (roomId: string) => void;
  swapPanes: (a: number, b: number) => void;
  toggleLayoutEditMode: () => void;
  setGridMirror: (value: boolean) => void;
  moveGridBottomChat: () => void;
  persistLayout: () => void;
  setActiveView: (view: 'chat' | 'contracts' | 'settings' | 'profile', settingsSection?: string) => void;
}

export const createLayoutSlice: StateCreator<AppState, [], [], LayoutSlice> = (set, get) => {
  return {
    paneRoomIds: loadPaneRoomIds(),
    paneLocks: [],
    poppedOutRoomIds: [],
    activePaneIndex: 0,
    unreadCounts: {},
    layoutEditMode: loadLayoutEditMode(),
    gridMirror: loadGridMirror(),
    _layoutHydrated: false,
    activeView: 'chat',
    settingsSection: null,

    // Opening a room from the sidebar replaces the first (primary) pane and keeps
    // any additional split panes intact, so a built layout survives a sidebar click.
    // Opening a room from the sidebar/hotkey changes the currently focused pane
    // (not always the first), and never changes a locked pane.
    setActiveRoom: (roomId) => {
      set((state) => {
        if (roomId === null) return { activeRoomId: null, activeView: 'chat' };
        if (state.paneRoomIds.length === 0) {
          savePaneRoomIds([roomId]);
          return { activeRoomId: roomId, activeView: 'chat', paneRoomIds: [roomId], activePaneIndex: 0, unreadCounts: { ...state.unreadCounts, [roomId]: 0 } };
        }
        const idx = Math.min(state.activePaneIndex, state.paneRoomIds.length - 1);
        if (state.paneLocks[idx]) {
          // Focused pane is locked: just make sure we're on the chat view.
          return { activeView: 'chat' };
        }
        const panes = [...state.paneRoomIds];
        panes[idx] = roomId;
        savePaneRoomIds(panes);
        return {
          activeRoomId: panes[0] ?? null,
          activeView: 'chat',
          paneRoomIds: panes,
          unreadCounts: { ...state.unreadCounts, [roomId]: 0 },
        };
      });
      get().persistLayout();
    },

    setPaneRoom: (index, roomId) => {
      set((state) => {
        if (index < 0 || index >= state.paneRoomIds.length) return state;
        if (state.paneLocks[index]) return state;
        const panes = [...state.paneRoomIds];
        panes[index] = roomId;
        savePaneRoomIds(panes);
        return {
          paneRoomIds: panes,
          activeRoomId: panes[0] ?? null,
          activePaneIndex: index,
          unreadCounts: { ...state.unreadCounts, [roomId]: 0 },
        };
      });
      get().persistLayout();
    },

    setActivePane: (index) => set((state) => {
      if (index < 0 || index >= state.paneRoomIds.length || index === state.activePaneIndex) return state;
      return { activePaneIndex: index };
    }),

    togglePaneLock: (index) => {
      set((state) => {
        if (index < 0 || index >= state.paneRoomIds.length) return state;
        const locks = [...state.paneLocks];
        while (locks.length < state.paneRoomIds.length) locks.push(false);
        locks[index] = !locks[index];
        return { paneLocks: locks };
      });
      get().persistLayout();
    },

    // Add a new pane (up to MAX_PANES), auto-filling with a room not already shown.
    addPane: () => {
      set((state) => {
        if (state.paneRoomIds.length >= MAX_PANES) return { activeView: 'chat' };
        const fill = pickPaneFill(state, state.paneRoomIds);
        const panes = [...state.paneRoomIds, fill];
        const locks = [...state.paneLocks];
        while (locks.length < panes.length) locks.push(false);
        savePaneRoomIds(panes);
        const unreadCounts = { ...state.unreadCounts };
        if (state.activeView === 'chat') unreadCounts[fill] = 0;
        return { paneRoomIds: panes, paneLocks: locks, activeView: 'chat', unreadCounts };
      });
      get().persistLayout();
    },

    removePane: (index) => {
      set((state) => {
        if (state.paneRoomIds.length <= 1) return state;
        const panes = state.paneRoomIds.filter((_, i) => i !== index);
        const locks = state.paneLocks.filter((_, i) => i !== index);
        savePaneRoomIds(panes);
        const activePaneIndex = Math.min(state.activePaneIndex, panes.length - 1);
        return { paneRoomIds: panes, paneLocks: locks, activeRoomId: panes[0] ?? null, activePaneIndex };
      });
      get().persistLayout();
    },

    // Detach a pane into a native popout window. The chat leaves the grid (which
    // may drop to zero panes -> "No room selected" empty state) and is tracked in
    // poppedOutRoomIds so it re-docks when the popout closes. Kept ephemeral: the
    // removal is not persisted, so the saved layout stays intact across restarts.
    popOutPane: (index) => {
      const state = get();
      if (index < 0 || index >= state.paneRoomIds.length) return;
      const roomId = state.paneRoomIds[index];
      const room = state.rooms.find((r) => r.id === roomId);
      const title = room?.name ?? (roomId === 'mentions' ? 'Mentions' : 'OCT');
      // Hand the popout the messages already loaded here so it shows history
      // immediately (covers rooms, DMs, and mentions, which /history can't).
      const seed = state.messages[roomId] ?? [];
      window.oct?.openPopout(roomId, title, seed);
      set((s) => {
        const panes = s.paneRoomIds.filter((_, i) => i !== index);
        const locks = s.paneLocks.filter((_, i) => i !== index);
        const activePaneIndex = Math.max(0, Math.min(s.activePaneIndex, panes.length - 1));
        const poppedOutRoomIds = s.poppedOutRoomIds.includes(roomId)
          ? s.poppedOutRoomIds
          : [...s.poppedOutRoomIds, roomId];
        return { paneRoomIds: panes, paneLocks: locks, activeRoomId: panes[0] ?? null, activePaneIndex, poppedOutRoomIds };
      });
    },

    // Re-dock a chat when its popout window closes.
    dockPopout: (roomId) => {
      set((s) => {
        if (!s.poppedOutRoomIds.includes(roomId)) return s;
        const poppedOutRoomIds = s.poppedOutRoomIds.filter((id) => id !== roomId);
        if (s.paneRoomIds.includes(roomId) || s.paneRoomIds.length >= MAX_PANES) {
          return { poppedOutRoomIds };
        }
        const panes = [...s.paneRoomIds, roomId];
        const locks = [...s.paneLocks];
        while (locks.length < panes.length) locks.push(false);
        return { paneRoomIds: panes, paneLocks: locks, activeRoomId: panes[0] ?? null, poppedOutRoomIds };
      });
    },

    swapPanes: (a, b) => {
      set((state) => {
        if (a === b || a < 0 || b < 0 || a >= state.paneRoomIds.length || b >= state.paneRoomIds.length) return state;
        if (state.paneLocks[a] || state.paneLocks[b]) return state;
        const panes = [...state.paneRoomIds];
        [panes[a], panes[b]] = [panes[b], panes[a]];
        const locks = [...state.paneLocks];
        while (locks.length < panes.length) locks.push(false);
        [locks[a], locks[b]] = [locks[b], locks[a]];
        savePaneRoomIds(panes);
        return { paneRoomIds: panes, paneLocks: locks, activeRoomId: panes[0] ?? null };
      });
      get().persistLayout();
    },

    toggleLayoutEditMode: () => set((state) => {
      const next = !state.layoutEditMode;
      try { localStorage.setItem(EDIT_MODE_STORAGE_KEY, next ? '1' : '0'); } catch {}
      return { layoutEditMode: next };
    }),

    setGridMirror: (value) => {
      try { localStorage.setItem(GRID_MIRROR_STORAGE_KEY, value ? '1' : '0'); } catch {}
      set({ gridMirror: value });
      get().persistLayout();
    },

    // In a 3-pane two-rows grid, move the bottom stacked chat to the other
    // column's bottom (the remaining chats re-fill). With only two columns this
    // is exactly reversing the pane order and flipping the mirror.
    moveGridBottomChat: () => {
      set((state) => {
        const panes = [...state.paneRoomIds].reverse();
        const locks = [...state.paneLocks];
        while (locks.length < state.paneRoomIds.length) locks.push(false);
        const newLocks = locks.slice(0, state.paneRoomIds.length).reverse();
        const mirror = !state.gridMirror;
        savePaneRoomIds(panes);
        try { localStorage.setItem(GRID_MIRROR_STORAGE_KEY, mirror ? '1' : '0'); } catch {}
        return {
          paneRoomIds: panes,
          paneLocks: newLocks,
          gridMirror: mirror,
          activeRoomId: panes[0] ?? null,
          activePaneIndex: Math.max(0, state.paneRoomIds.length - 1 - state.activePaneIndex),
        };
      });
      get().persistLayout();
    },

    // Persist the current split layout (panes + mirror) to the backend config so
    // it survives restarts even when localStorage is unavailable (desktop app).
    persistLayout: () => {
      if (IS_POPOUT) return;
      const { paneRoomIds, paneLocks, gridMirror } = get();
      apiFetch(`${API_BASE}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paneRoomIds, paneLocks, gridMirror }),
      }).catch(() => {});
    },

    setActiveView: (view, settingsSection) => set((state) => {
      // Returning to the chat view means the open panes are visible again, so
      // clear their unread badges.
      if (view === 'chat' && state.paneRoomIds.length > 0) {
        const unreadCounts = { ...state.unreadCounts };
        for (const id of state.paneRoomIds) unreadCounts[id] = 0;
        return { activeView: view, settingsSection: settingsSection ?? null, unreadCounts };
      }
      return { activeView: view, settingsSection: settingsSection ?? null };
    }),
  };
};
