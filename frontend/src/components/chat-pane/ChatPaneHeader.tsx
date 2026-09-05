import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/appStore';
import { selectDmSwitcherEntries, parseDmSwitcherEntry } from '../../utils/dmSwitcherEntries';
import type { Room } from '../../types';
import { Hash, MessageCircle, Settings, Filter, EyeOff, X, Eye, Search, ChevronDown, Send, AtSign, GripVertical, Plus, Rows2, Columns2, ArrowLeft, ArrowRight, Lock, Unlock, ExternalLink } from 'lucide-react';

const MAX_PANES = 4;

// Instant styled hover label ("legend") for the compact header icon buttons.
function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative group/tip flex items-center">
      {children}
      <span className="pointer-events-none absolute top-full right-0 mt-1.5 z-50 whitespace-nowrap rounded-cockpit border-2 border-oct-border bg-oct-surface-raised px-2 py-1 type-caption font-mono font-bold uppercase tracking-wide text-oct-text shadow-oct-hard-sm opacity-0 group-hover/tip:opacity-100 transition-opacity duration-100">
        {label}
      </span>
    </div>
  );
}

export type ChatPaneVariant = 'grid' | 'popout' | 'workspace';

interface ChatPaneHeaderProps {
  roomId: string;
  paneIndex: number;
  paneCount: number;
  editMode: boolean;
  variant: ChatPaneVariant;
  locked: boolean;
  /** Feed chrome already names the room: drop the switcher, keep the controls. */
  chromeOwnsHeader: boolean;
  activeRoom: Room | undefined;
  isDMView: boolean;
  isTgDMView: boolean;
  isMentionsView: boolean;
  headerTitle: string;
  focusActive: boolean;
  onClearFocus: () => void;
  hiddenCount: number;
  hiddenPanelOpen: boolean;
  onToggleHiddenPanel: () => void;
  searchOpen: boolean;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onSelectRoom: (roomId: string) => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

/**
 * The pane's top row: drag handle, room switcher, status chips and the icon
 * controls. Owns the switcher dropdown state and the store subscriptions only
 * the header consumes (pane layout actions, DM rooms for the switcher list).
 */
export default function ChatPaneHeader({
  roomId, paneIndex, paneCount, editMode, variant, locked, chromeOwnsHeader, activeRoom,
  isDMView, isTgDMView, isMentionsView, headerTitle, focusActive, onClearFocus,
  hiddenCount, hiddenPanelOpen, onToggleHiddenPanel, searchOpen, onOpenSearch, onCloseSearch,
  onSelectRoom, onMoveLeft, onMoveRight,
}: ChatPaneHeaderProps) {
  const isPopout = variant === 'popout';
  const isWorkspace = variant === 'workspace';
  const isAnyDMView = isDMView || isTgDMView;

  const rooms = useAppStore((s) => s.rooms);
  const dmChannels = useAppStore((s) => s.dmChannels);
  // The room-switcher dropdown lists DM rooms that hold messages. Folded to
  // label strings + shallow-compared so cross-room traffic stays quiet here too.
  const dmSwitcherEntries = useAppStore(useShallow((s) => selectDmSwitcherEntries(s.messages)));
  const updateRoom = useAppStore((s) => s.updateRoom);
  const openConfigModal = useAppStore((s) => s.openConfigModal);
  const popOutPane = useAppStore((s) => s.popOutPane);
  const poppedOutRoomIds = useAppStore((s) => s.poppedOutRoomIds);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const isGrid = useAppStore((s) => s.config?.splitLayout === 'grid');
  const togglePaneLock = useAppStore((s) => s.togglePaneLock);
  const addPane = useAppStore((s) => s.addPane);
  const removePane = useAppStore((s) => s.removePane);

  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Options for the per-pane room switcher dropdown.
  const switcherOptions = useMemo(() => {
    const opts: { id: string; label: string; kind: 'mentions' | 'room' | 'dm' | 'tg' }[] = [];
    opts.push({ id: 'mentions', label: 'Mentions', kind: 'mentions' });
    for (const r of rooms) opts.push({ id: r.id, label: r.name, kind: 'room' });
    const dmLookup = new Map(dmChannels.map((dm) => [dm.id, dm]));
    for (const entry of dmSwitcherEntries) {
      const { key, channelName, authorName } = parseDmSwitcherEntry(entry);
      if (key.startsWith('dm:')) {
        const dm = dmLookup.get(key.slice(3));
        const label = dm ? dm.recipients.map((r) => r.global_name || r.username || 'Unknown').join(', ') : (authorName || 'DM');
        opts.push({ id: key, label, kind: 'dm' });
      } else {
        opts.push({ id: key, label: channelName || authorName || 'Telegram Chat', kind: 'tg' });
      }
    }
    return opts;
  }, [rooms, dmChannels, dmSwitcherEntries]);

  const toggleFilter = () => {
    if (activeRoom) {
      updateRoom(activeRoom.id, { filterEnabled: !activeRoom.filterEnabled });
    }
  };

  const HeaderIcon = isMentionsView ? AtSign : isTgDMView ? Send : isDMView ? MessageCircle : Hash;
  const headerIconClass = isTgDMView ? 'text-oct-accent' : 'text-oct-muted';

  const canDrag = editMode && paneCount > 1 && !locked && !isWorkspace;
  const canPopOut = variant === 'grid' && !!window.oct?.openPopout && !poppedOutRoomIds.includes(roomId);

  return (
    <div className={`${chromeOwnsHeader ? 'h-9' : 'h-12'} px-2 sm:px-4 flex items-center border-b-2 border-oct-border shrink-0 bg-transparent z-10 gap-1`}>
      {canDrag && (
        <div
          draggable
          onDragStart={(e) => { e.dataTransfer.setData('text/plain', `pane:${paneIndex}`); e.dataTransfer.effectAllowed = 'move'; }}
          className="p-0.5 -ml-0.5 mr-0.5 rounded-cockpit text-oct-muted hover:text-oct-text cursor-grab active:cursor-grabbing shrink-0"
          title="Drag to rearrange pane"
        >
          <GripVertical size={16} />
        </div>
      )}

      {/* Room switcher */}
      {!chromeOwnsHeader && (
        <div className="relative min-w-0 flex items-center">
          <button
            onClick={() => { if (!locked) setSwitcherOpen((v) => !v); }}
            className="flex items-center gap-1.5 min-w-0 rounded-cockpit px-1 py-0.5 hover:bg-oct-surface-raised transition-colors duration-100"
            title={locked ? 'Pane locked - unlock to change room' : 'Switch pane content'}
          >
            <HeaderIcon size={20} className={`${headerIconClass} shrink-0`} />
            <span className="font-mono text-sm sm:text-base font-bold uppercase tracking-wide text-oct-text truncate max-w-[40vw] sm:max-w-none">
              {headerTitle}
            </span>
            {locked ? <Lock size={13} className="text-oct-muted shrink-0" /> : <ChevronDown size={14} className="text-oct-muted shrink-0" />}
          </button>
          {switcherOpen && !locked && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setSwitcherOpen(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 w-56 max-h-[60vh] overflow-y-auto rounded-cockpit border-2 border-oct-border bg-oct-surface-raised shadow-oct-hard-lg py-1">
                {switcherOptions.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => { onSelectRoom(opt.id); setSwitcherOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left font-mono text-xs uppercase tracking-wide truncate transition-colors duration-100 ${
                      opt.id === roomId
                        ? 'bg-oct-accent-dim text-oct-accent'
                        : 'text-oct-text hover:bg-oct-accent-dim hover:text-oct-accent'
                    }`}
                  >
                    {opt.kind === 'mentions' ? <AtSign size={16} className="shrink-0 opacity-70" />
                      : opt.kind === 'tg' ? <Send size={16} className="shrink-0 text-oct-accent" />
                      : opt.kind === 'dm' ? <MessageCircle size={16} className="shrink-0 opacity-70" />
                      : <Hash size={16} className="shrink-0 opacity-70" />}
                    <span className="truncate">{opt.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {!chromeOwnsHeader && !isAnyDMView && !isMentionsView && activeRoom && (
        <span className="ml-2 font-mono text-2xs sm:text-xs uppercase tracking-[0.15em] text-oct-muted truncate hidden lg:inline">
          {activeRoom.channels.length} channel{activeRoom.channels.length !== 1 ? 's' : ''}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        {activeRoom && activeRoom.highlightedUsers.length > 0 && (
          <span className="items-center gap-1 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim px-1.5 sm:px-2 py-0.5 type-caption font-mono font-bold uppercase tracking-wide text-oct-accent shrink-0 hidden lg:inline-flex">
            {activeRoom.highlightedUsers.length} highlighted
          </span>
        )}
        {activeRoom && (activeRoom.filteredUsers?.length ?? 0) > 0 && (
          <button
            onClick={toggleFilter}
            className={`inline-flex items-center gap-1 rounded-cockpit border-2 px-1.5 sm:px-2 py-0.5 type-caption font-mono font-bold uppercase tracking-wide shrink-0 transition-colors duration-100 ${
              activeRoom.filterEnabled
                ? 'border-oct-good bg-oct-good/15 text-oct-good'
                : 'border-oct-border bg-oct-surface-raised text-oct-muted hover:text-oct-text'
            }`}
            title={activeRoom.filterEnabled ? 'Click to disable user filter' : 'Click to enable user filter'}
          >
            <Filter size={10} />
            <span className="hidden lg:inline">{activeRoom.filteredUsers.length} filtered</span> {activeRoom.filterEnabled ? 'ON' : 'OFF'}
          </button>
        )}
        {focusActive && (
          <button
            onClick={onClearFocus}
            className="inline-flex items-center gap-1 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim px-1.5 sm:px-2 py-0.5 type-caption font-mono font-bold uppercase tracking-wide text-oct-accent hover:border-oct-accent-hover hover:text-oct-accent-hover transition-colors duration-100 max-w-[120px] sm:max-w-none"
            title="Click to exit focus mode"
          >
            <Eye size={10} className="shrink-0" />
            <span className="truncate">Focus</span>
            <X size={10} className="shrink-0" />
          </button>
        )}
        {hiddenCount > 0 && (
          <button
            onClick={onToggleHiddenPanel}
            className={`inline-flex items-center gap-1 rounded-cockpit border-2 px-1.5 sm:px-2 py-0.5 type-caption font-mono font-bold uppercase tracking-wide shrink-0 transition-colors duration-100 ${
              hiddenPanelOpen
                ? 'border-oct-flame bg-oct-flame/15 text-oct-flame'
                : 'border-oct-border bg-oct-surface-raised text-oct-muted hover:text-oct-text'
            }`}
            title="View hidden users"
          >
            <EyeOff size={10} />
            <span className="hidden lg:inline">{hiddenCount} hidden</span>
          </button>
        )}
        <Tip label={searchOpen ? 'Close search' : 'Search messages (Ctrl+F)'}>
          <button
            onClick={searchOpen ? onCloseSearch : onOpenSearch}
            className={`p-1 transition-colors duration-100 ${
              searchOpen ? 'text-oct-accent' : 'text-oct-muted hover:text-oct-accent'
            }`}
          >
            <Search size={18} />
          </button>
        </Tip>
        {activeRoom && (
          <Tip label="Room settings">
            <button
              onClick={() => openConfigModal(activeRoom)}
              className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
            >
              <Settings size={18} />
            </button>
          </Tip>
        )}
        {canPopOut && (
          <Tip label="Pop out to its own window">
            <button
              onClick={() => popOutPane(paneIndex)}
              className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
            >
              <ExternalLink size={18} />
            </button>
          </Tip>
        )}
        {editMode && !isWorkspace && onMoveLeft && (
          <Tip label="Move chat to left side">
            <button
              onClick={onMoveLeft}
              className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
            >
              <ArrowLeft size={18} />
            </button>
          </Tip>
        )}
        {editMode && !isWorkspace && onMoveRight && (
          <Tip label="Move chat to right side">
            <button
              onClick={onMoveRight}
              className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
            >
              <ArrowRight size={18} />
            </button>
          </Tip>
        )}
        {paneIndex === 0 && paneCount > 1 && !isWorkspace && (
          <Tip label={isGrid ? 'Single row layout' : 'Two rows layout'}>
            <button
              onClick={() => updateConfig({ splitLayout: isGrid ? 'row' : 'grid' })}
              className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
            >
              {isGrid ? <Columns2 size={18} /> : <Rows2 size={18} />}
            </button>
          </Tip>
        )}
        {!isPopout && !isWorkspace && (
          <Tip label={locked ? 'Unlock pane' : 'Lock pane (prevent changing room)'}>
            <button
              onClick={() => togglePaneLock(paneIndex)}
              className={`p-1 transition-colors duration-100 ${locked ? 'text-oct-accent hover:text-oct-accent-hover' : 'text-oct-muted hover:text-oct-accent'}`}
            >
              {locked ? <Lock size={18} /> : <Unlock size={18} />}
            </button>
          </Tip>
        )}
        {!isPopout && !isWorkspace && paneCount < MAX_PANES && (
          <Tip label="Add chat pane">
            <button
              onClick={() => addPane()}
              className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
            >
              <Plus size={18} />
            </button>
          </Tip>
        )}
        {paneCount > 1 && !isWorkspace && (
          <Tip label="Close pane">
            <button
              onClick={() => removePane(paneIndex)}
              className="p-1 text-oct-muted hover:text-oct-flame transition-colors duration-100"
            >
              <X size={18} />
            </button>
          </Tip>
        )}
      </div>
    </div>
  );
}
