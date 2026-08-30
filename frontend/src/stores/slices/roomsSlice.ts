import type { StateCreator } from 'zustand';
import type { Room } from '../../types';
import type { AppState } from '../appStore';
import { apiFetch, API_BASE, savePaneRoomIds, loadPaneRoomIds } from '../appStore.helpers';
import { track } from '../../lib/analytics';

export interface RoomsSlice {
  rooms: Room[];
  activeRoomId: string | null;

  fetchRooms: () => Promise<void>;
  createRoom: (name: string, channels: Room['channels'], highlightedUsers: string[], color?: string | null, filteredUsers?: string[], filterEnabled?: boolean) => Promise<Room>;
  updateRoom: (id: string, data: Partial<Omit<Room, 'id'>>) => Promise<void>;
  deleteRoom: (id: string) => Promise<void>;
}

export const createRoomsSlice: StateCreator<AppState, [], [], RoomsSlice> = (set, get) => {
  return {
    rooms: [],
    activeRoomId: loadPaneRoomIds()[0] ?? null,

    fetchRooms: async () => {
      try {
        const res = await apiFetch(`${API_BASE}/rooms`);
        if (!res.ok) return;
        const rooms: Room[] = await res.json();
        set({ rooms });
        if (rooms.length > 0 && !get().activeRoomId) {
          const firstId = rooms[0].id;
          savePaneRoomIds([firstId]);
          set({ activeRoomId: firstId, paneRoomIds: [firstId] });
        }
      } catch {}
    },

    createRoom: async (name, channels, highlightedUsers, color, filteredUsers, filterEnabled) => {
      const res = await apiFetch(`${API_BASE}/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, channels, highlightedUsers, color: color ?? null, filteredUsers: filteredUsers ?? [], filterEnabled: filterEnabled ?? false }),
      });
      const room: Room = await res.json();
      // Activation milestone: a room is where feeds actually happen. Counts
      // only — never the channel names or user handles being tracked.
      track('room_created', {
        channels: channels.length,
        highlighted_users: highlightedUsers.length,
        filter_enabled: filterEnabled ?? false,
      });
      await get().fetchRooms();
      return room;
    },

    updateRoom: async (id, data) => {
      await apiFetch(`${API_BASE}/rooms/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      await get().fetchRooms();
    },

    deleteRoom: async (id) => {
      await apiFetch(`${API_BASE}/rooms/${id}`, { method: 'DELETE' });
      const state = get();
      const remaining = state.rooms.filter((r) => r.id !== id);
      let panes = state.paneRoomIds.filter((p) => p !== id);
      if (panes.length === 0) {
        const fallback = remaining[0]?.id;
        panes = fallback ? [fallback] : [];
      }
      savePaneRoomIds(panes);
      set({ paneRoomIds: panes, activeRoomId: panes[0] ?? null });
      get().persistLayout();
      await get().fetchRooms();
    },
  };
};
