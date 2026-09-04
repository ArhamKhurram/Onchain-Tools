import { useMemo } from 'react';
import { useAppStore } from '../../stores/appStore';
import type { DMChannel, Room } from '../../types';
import type { FeedChromeEntry, FeedChromeModel, FeedChromePreset } from './feedChromeContract';

function labelForRoomId(roomId: string | null, rooms: Room[], dmChannels: DMChannel[]): string {
  if (!roomId) return 'NO ROOM';
  if (roomId === 'mentions') return '@MENTIONS';
  const room = rooms.find((r) => r.id === roomId);
  if (room) return `#${room.name.toUpperCase()}`;
  if (roomId.startsWith('dm:')) {
    const dm = dmChannels.find((d) => d.id === roomId.slice(3));
    const names = dm?.recipients.map((r) => r.global_name || r.username || 'Unknown').join(', ');
    return (names || 'Direct Message').toUpperCase();
  }
  if (roomId.startsWith('tg-dm:')) return 'TELEGRAM DM';
  return 'UNKNOWN';
}

export function useFeedChromeModel(preset: FeedChromePreset): FeedChromeModel {
  const rooms = useAppStore((s) => s.rooms);
  const dmChannels = useAppStore((s) => s.dmChannels);
  const paneRoomIds = useAppStore((s) => s.paneRoomIds);
  const activePaneIndex = useAppStore((s) => s.activePaneIndex);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const contractCount = useAppStore((s) => s.contracts.length);
  const connected = useAppStore((s) => s.connected);
  const authStatus = useAppStore((s) => s.authStatus);
  const layoutEditMode = useAppStore((s) => s.layoutEditMode);
  const setActiveRoom = useAppStore((s) => s.setActiveRoom);
  const openConfigModal = useAppStore((s) => s.openConfigModal);
  const toggleLayoutEditMode = useAppStore((s) => s.toggleLayoutEditMode);
  const updateConfig = useAppStore((s) => s.updateConfig);

  const activeRoomId = paneRoomIds[activePaneIndex] ?? paneRoomIds[0] ?? null;
  const activeRoom = rooms.find((r) => r.id === activeRoomId);

  const entries = useMemo<FeedChromeEntry[]>(() => {
    const open = new Set(paneRoomIds);
    return [
      {
        id: 'mentions',
        label: 'MENTIONS',
        kind: 'mentions',
        unread: unreadCounts['mentions'] ?? 0,
        active: open.has('mentions'),
      },
      ...rooms.map<FeedChromeEntry>((room) => ({
        id: room.id,
        label: room.name.toUpperCase(),
        kind: 'room',
        unread: unreadCounts[room.id] ?? 0,
        active: open.has(room.id),
      })),
    ];
  }, [rooms, paneRoomIds, unreadCounts]);

  const unreadTotal = useMemo(
    () => Object.values(unreadCounts).reduce((sum, n) => sum + n, 0),
    [unreadCounts],
  );

  return {
    preset,
    rooms,
    entries,
    activeRoom,
    activeRoomId,
    activeLabel: labelForRoomId(activeRoomId, rooms, dmChannels),
    channelCount: activeRoom?.channels.length ?? 0,
    paneRoomIds,
    activePaneIndex,
    paneCount: paneRoomIds.length,
    contractCount,
    highlightCount: activeRoom?.highlightedUsers.length ?? 0,
    unreadTotal,
    discordConnected: connected,
    telegramConfigured: authStatus?.telegramConfigured ?? false,
    telegramConnected: authStatus?.telegramConnected ?? false,
    layoutEditMode,
    selectRoom: setActiveRoom,
    createRoom: () => openConfigModal(),
    configureActiveRoom: () => openConfigModal(activeRoom),
    toggleLayoutEditMode,
    // Same write Settings > General makes on save, so the in-feed switcher and
    // the settings form share one persistence path (local JSON or hosted
    // JSONB — updateConfig already knows which).
    setPreset: (next) => { void updateConfig({ feedChromePreset: next }); },
  };
}
