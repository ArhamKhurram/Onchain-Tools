import type { Room, AppConfig, FrontendMessage, ContractEntry } from '../types';

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true';

// Fixtures load via dynamic import. A static `import { DEMO_ROOMS, ... }` here
// pinned demoData (~17 kB of sample fixtures) into the initial index chunk of
// every PRODUCTION build: rollup refuses to move a module into a lazy chunk
// while any eager module still declares a static import edge to it — even this
// one, whose own code is entirely tree-shaken when VITE_DEMO_MODE is off.
// In the demo build the fetch starts at module init and every fixture-reading
// override awaits it, so the only observable change is fixtures arriving one
// microtask-plus-chunk-fetch after boot.
const fixturesPromise = isDemoMode ? import('./demoData') : null;

type SetFn = (
  partial:
    | Record<string, unknown>
    | ((state: Record<string, unknown>) => Record<string, unknown>),
) => void;
type GetFn = () => Record<string, unknown>;

// Deep-clone helper so mutations stay session-local
function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

let _roomCounter = 100;

export function createDemoOverrides(set: SetFn, get: GetFn) {
  // Non-null: createDemoOverrides is only reachable when isDemoMode is true
  // (every caller gates on it), and fixturesPromise is created in that mode.
  const fixtures = () => fixturesPromise!;

  return {
    checkAuth: () => {
      set({ authStatus: { configured: true, connected: true }, authLoading: false });
    },

    submitToken: () => ({ success: true }),
    addToken: () => ({ success: true }),
    removeToken: () => ({ success: true }),

    fetchMaskedTokens: async () => {
      const F = await fixtures();
      set({ maskedTokens: clone(F.DEMO_MASKED_TOKENS) });
    },

    fetchRooms: async () => {
      const F = await fixtures();
      const state = get();
      const rooms = (state.rooms as Room[]);
      if (rooms.length === 0) {
        const demoRooms = clone(F.DEMO_ROOMS);
        const firstId = demoRooms[0]?.id ?? null;
        set({ rooms: demoRooms, activeRoomId: firstId, paneRoomIds: firstId ? [firstId] : [] });
      }
    },

    fetchHistory: async () => {
      const F = await fixtures();
      set((state: Record<string, unknown>) => {
        const existing = state.messages as Record<string, FrontendMessage[]>;
        const hasData = Object.values(existing).some((msgs) => msgs.length > 0);
        if (hasData) return state;
        return { messages: clone(F.DEMO_MESSAGES) };
      });
    },

    fetchGuilds: async () => {
      const F = await fixtures();
      set({ guilds: clone(F.DEMO_GUILDS) });
    },

    fetchDMChannels: async () => {
      const F = await fixtures();
      set({ dmChannels: clone(F.DEMO_DM_CHANNELS) });
    },

    fetchConfig: async () => {
      const F = await fixtures();
      const state = get();
      if (!state.config) {
        set({ config: clone(F.DEMO_CONFIG) });
      }
    },

    fetchContracts: async () => {
      const F = await fixtures();
      const state = get();
      if ((state.contracts as ContractEntry[]).length === 0) {
        const contracts = clone(F.DEMO_CONTRACTS) as ContractEntry[];
        const addressChains: Record<string, string> = {};
        for (const c of contracts) {
          if (c.chain === 'evm' && c.evmChain) addressChains[c.address.toLowerCase()] = c.evmChain;
        }
        set({ contracts, addressChains });
      }
    },

    createRoom: (
      name: string,
      channels: Room['channels'],
      highlightedUsers: string[],
      color?: string | null,
      filteredUsers?: string[],
      filterEnabled?: boolean,
    ): Room => {
      const room: Room = {
        id: `demo-room-${++_roomCounter}`,
        name,
        channels,
        highlightedUsers,
        filteredUsers: filteredUsers ?? [],
        filterEnabled: filterEnabled ?? false,
        color: color ?? null,
      };
      set((state: Record<string, unknown>) => ({
        rooms: [...(state.rooms as Room[]), room],
      }));
      return room;
    },

    updateRoom: (id: string, data: Partial<Omit<Room, 'id'>>) => {
      set((state: Record<string, unknown>) => ({
        rooms: (state.rooms as Room[]).map((r) =>
          r.id === id ? { ...r, ...data } : r,
        ),
      }));
    },

    deleteRoom: (id: string) => {
      set((state: Record<string, unknown>) => {
        const rooms = (state.rooms as Room[]).filter((r) => r.id !== id);
        let panes = (state.paneRoomIds as string[]).filter((p) => p !== id);
        if (panes.length === 0 && rooms[0]) panes = [rooms[0].id];
        return { rooms, paneRoomIds: panes, activeRoomId: panes[0] ?? null };
      });
    },

    updateConfig: (data: Partial<AppConfig>) => {
      set((state: Record<string, unknown>) => ({
        config: { ...(state.config as AppConfig), ...data },
      }));
    },

    hideUser: (guildId: string | null, channelId: string, userId: string, displayName: string) => {
      const config = get().config as AppConfig | null;
      if (!config) return;
      const key = `${guildId ?? 'null'}:${channelId}`;
      const current = config.hiddenUsers?.[key] ?? [];
      if (current.some((e) => e.userId === userId)) return;
      const hiddenUsers = { ...config.hiddenUsers, [key]: [...current, { userId, displayName }] };
      set({ config: { ...config, hiddenUsers } });
    },

    unhideUser: (guildId: string | null, channelId: string, userId: string) => {
      const config = get().config as AppConfig | null;
      if (!config) return;
      const key = `${guildId ?? 'null'}:${channelId}`;
      const current = config.hiddenUsers?.[key] ?? [];
      const filtered = current.filter((e) => e.userId !== userId);
      const hiddenUsers = { ...config.hiddenUsers };
      if (filtered.length === 0) {
        delete hiddenUsers[key];
      } else {
        hiddenUsers[key] = filtered;
      }
      set({ config: { ...config, hiddenUsers } });
    },

    deleteContract: (messageId: string, address: string) => {
      set((state: Record<string, unknown>) => ({
        contracts: (state.contracts as ContractEntry[]).filter(
          (c) => !(c.messageId === messageId && c.address === address),
        ),
      }));
    },

    deleteAllContracts: () => {
      set({ contracts: [] });
    },
  };
}
