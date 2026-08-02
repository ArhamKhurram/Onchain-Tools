import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedChromeModel } from './feedChromeContract';

interface PaletteItem {
  id: string;
  group: 'ROOMS' | 'ACTIONS';
  glyph: string;
  label: string;
  unread: number;
  open: boolean;
  run: () => void;
}

interface RoomPaletteProps {
  open: boolean;
  model: FeedChromeModel;
  onClose: () => void;
}

export default function RoomPalette({ open, model, onClose }: RoomPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const {
    entries,
    activeRoom,
    layoutEditMode,
    selectRoom,
    createRoom,
    configureActiveRoom,
    toggleLayoutEditMode,
  } = model;

  const items = useMemo<PaletteItem[]>(() => {
    const rooms = entries.map<PaletteItem>((entry) => ({
      id: entry.id,
      group: 'ROOMS',
      glyph: entry.kind === 'mentions' ? '@' : '#',
      label: entry.label,
      unread: entry.unread,
      open: entry.active,
      run: () => selectRoom(entry.id),
    }));

    const actions: PaletteItem[] = [
      { id: 'action:new-room', group: 'ACTIONS', glyph: '+', label: 'NEW ROOM', unread: 0, open: false, run: createRoom },
    ];
    if (activeRoom) {
      actions.push({
        id: 'action:configure-room',
        group: 'ACTIONS',
        glyph: '*',
        label: `EDIT ROOM · ${activeRoom.name.toUpperCase()}`,
        unread: 0,
        open: false,
        run: configureActiveRoom,
      });
    }
    actions.push({
      id: 'action:layout',
      group: 'ACTIONS',
      glyph: '=',
      label: layoutEditMode ? 'EXIT LAYOUT EDIT MODE' : 'EDIT PANE LAYOUT',
      unread: 0,
      open: layoutEditMode,
      run: toggleLayoutEditMode,
    });

    return [...rooms, ...actions];
  }, [entries, activeRoom, layoutEditMode, selectRoom, createRoom, configureActiveRoom, toggleLayoutEditMode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    itemRefs.current[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected, filtered.length]);

  if (!open) return null;

  const commit = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.run();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => (filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(filtered[selected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup: PaletteItem['group'] | null = null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh] bg-black/70"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-lg rounded-cockpit border-2 border-oct-border bg-oct-bg shadow-oct-hard"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 h-11 px-3 border-b-2 border-oct-border bg-oct-surface">
          <span className="font-mono text-xs font-bold tracking-[0.16em] text-oct-accent shrink-0">&gt;</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="JUMP TO ROOM"
            className="flex-1 min-w-0 bg-transparent font-mono text-sm uppercase tracking-[0.08em] text-oct-text placeholder:text-oct-muted/70 focus:outline-none"
            autoFocus
          />
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-oct-muted shrink-0">Esc</span>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center font-mono text-xs uppercase tracking-[0.16em] text-oct-muted">
              No matches
            </p>
          )}
          {filtered.map((item, i) => {
            const heading = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            const isSelected = i === selected;
            return (
              <div key={item.id}>
                {heading && (
                  <div className="px-3 pt-2 pb-1 font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-oct-muted">
                    {heading}
                  </div>
                )}
                <button
                  type="button"
                  ref={(el) => { itemRefs.current[i] = el; }}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => commit(item)}
                  className={[
                    'w-full flex items-center gap-2.5 px-3 py-2 text-left border-l-2 font-mono text-xs uppercase tracking-[0.08em] transition-colors duration-100',
                    isSelected
                      ? 'border-oct-accent bg-oct-accent-dim text-oct-accent'
                      : 'border-transparent text-oct-text hover:text-oct-accent',
                  ].join(' ')}
                >
                  <span className={`shrink-0 font-bold ${isSelected ? 'text-oct-accent' : 'text-oct-muted'}`}>
                    {item.glyph}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.open && (
                    <span className="shrink-0 font-mono text-[10px] tracking-[0.16em] text-oct-muted">Open</span>
                  )}
                  {item.unread > 0 && (
                    <span className="shrink-0 min-w-[20px] px-1 py-0.5 rounded-cockpit bg-oct-accent text-white text-center text-[10px] font-bold leading-none">
                      {item.unread > 99 ? '99+' : item.unread}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 px-3 py-2 border-t-2 border-oct-border bg-oct-surface font-mono text-[10px] uppercase tracking-[0.16em] text-oct-muted">
          <span>↑↓ Navigate</span>
          <span>⏎ Open</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
