import { Link } from 'react-router-dom';
import { routes } from '../../lib/routes';
import { Hash, Plus, Settings, AtSign, FileText, LayoutGrid } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

export default function FeedToolbar() {
  const rooms = useAppStore((s) => s.rooms);
  const paneRoomIds = useAppStore((s) => s.paneRoomIds);
  const activePaneIndex = useAppStore((s) => s.activePaneIndex);
  const unreadCounts = useAppStore((s) => s.unreadCounts);
  const setActiveRoom = useAppStore((s) => s.setActiveRoom);
  const openConfigModal = useAppStore((s) => s.openConfigModal);
  const connected = useAppStore((s) => s.connected);
  const authStatus = useAppStore((s) => s.authStatus);
  const contracts = useAppStore((s) => s.contracts);
  const layoutEditMode = useAppStore((s) => s.layoutEditMode);
  const toggleLayoutEditMode = useAppStore((s) => s.toggleLayoutEditMode);

  const activeRoomId = paneRoomIds[activePaneIndex] ?? paneRoomIds[0] ?? null;
  const activeRoom = rooms.find((r) => r.id === activeRoomId);
  const paneCount = paneRoomIds.length;

  const isActive = (id: string) => paneRoomIds.includes(id);

  const renderUnread = (count: number) =>
    count > 0 ? (
      <span className="min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-oct-accent text-white text-[10px] font-bold leading-none">
        {count > 99 ? '99+' : count}
      </span>
    ) : null;

  return (
    <div className="shrink-0 h-10 px-3 flex items-center gap-2 border-b-2 border-black bg-black">
      {/* Room tabs */}
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto scrollbar-none">
        <button
          type="button"
          onClick={() => setActiveRoom('mentions')}
          className={[
            'shrink-0 flex items-center gap-1.5 px-2.5 py-1 font-mono text-[10px] sm:text-xs uppercase tracking-[0.1em] transition-colors',
            isActive('mentions')
              ? 'text-oct-accent border-b-2 border-oct-accent'
              : 'text-oct-muted hover:text-oct-text',
          ].join(' ')}
          title="Mentions"
        >
          <AtSign size={14} />
          <span className="hidden sm:inline">Mentions</span>
          {renderUnread(unreadCounts['mentions'] ?? 0)}
        </button>

        {rooms.map((room) => {
          const unread = unreadCounts[room.id] ?? 0;
          const active = isActive(room.id);
          return (
            <button
              key={room.id}
              type="button"
              onClick={() => setActiveRoom(room.id)}
              className={[
                'shrink-0 flex items-center gap-1.5 px-2.5 py-1 font-mono text-[10px] sm:text-xs uppercase tracking-[0.1em] transition-colors max-w-[140px]',
                active
                  ? 'text-oct-accent border-b-2 border-oct-accent'
                  : 'text-oct-muted hover:text-oct-text',
              ].join(' ')}
              title={room.name}
            >
              <Hash size={14} className="shrink-0" />
              <span className="truncate">{room.name}</span>
              {renderUnread(unread)}
            </button>
          );
        })}

        {rooms.length === 0 && (
          <span className="text-xs text-oct-muted px-2">No rooms yet</span>
        )}
      </div>

      {/* Pane indicator when split */}
      {paneCount > 1 && (
        <div className="hidden sm:flex items-center gap-1 shrink-0" title={`${paneCount} panes open`}>
          {paneRoomIds.map((id, i) => (
            <span
              key={`${id}-${i}`}
              className={[
                'w-2 h-2 rounded-full',
                i === activePaneIndex ? 'bg-oct-accent' : 'bg-oct-border-bright',
              ].join(' ')}
            />
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => openConfigModal()}
          className="p-1.5 rounded-md text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors"
          title="Create room"
        >
          <Plus size={16} />
        </button>

        {activeRoom && (
          <button
            type="button"
            onClick={() => openConfigModal(activeRoom)}
            className="p-1.5 rounded-md text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors"
            title="Edit room"
          >
            <Settings size={16} />
          </button>
        )}

        <button
          type="button"
          onClick={toggleLayoutEditMode}
          className={[
            'p-1.5 rounded-md transition-colors',
            layoutEditMode
              ? 'text-oct-accent bg-oct-accent-dim'
              : 'text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised',
          ].join(' ')}
          title={layoutEditMode ? 'Exit layout edit mode' : 'Edit pane layout'}
        >
          <LayoutGrid size={16} />
        </button>

        <Link
          to={`${routes.callers}?view=feed`}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors"
          title="Contract feed"
        >
          <FileText size={14} />
          <span className="hidden sm:inline">Contracts</span>
          {contracts.length > 0 && (
            <span className="text-[10px] text-oct-muted tabular-nums">{contracts.length}</span>
          )}
        </Link>

        <div className="flex items-center gap-1.5 pl-1 border-l border-oct-border">
          <div
            className={`w-2 h-2 rounded-full ${connected ? 'bg-oct-green' : 'bg-oct-accent'}`}
            title={connected ? 'Discord connected' : 'Discord disconnected'}
          />
          {authStatus?.telegramConfigured && (
            <div
              className={`w-2 h-2 rounded-full ${authStatus.telegramConnected ? 'bg-[#2AABEE]' : 'bg-oct-yellow'}`}
              title={authStatus.telegramConnected ? 'Telegram connected' : 'Telegram disconnected'}
            />
          )}
        </div>
      </div>
    </div>
  );
}
