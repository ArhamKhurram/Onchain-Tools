import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import {
  WORKSPACE_MAX_PANELS,
  WORKSPACE_WIDGETS,
  appendPanelToColumn,
  countPanels,
  defaultAddColumnId,
} from '../../data/workspaceWidgets';
import type { WorkspaceLayout, WorkspacePanelType } from '../../types/workspace';

interface WidgetPickerProps {
  layout: WorkspaceLayout;
  onChange: (layout: WorkspaceLayout) => void;
  onPickRoom: () => void;
}

export default function WidgetPicker({ layout, onChange, onPickRoom }: WidgetPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const rooms = useAppStore((s) => s.rooms);
  const panelCount = countPanels(layout);
  const atMax = panelCount >= WORKSPACE_MAX_PANELS;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const handleAdd = (type: WorkspacePanelType) => {
    if (atMax) return;
    setOpen(false);
    const columnId = defaultAddColumnId(layout);
    if (type === 'room') {
      const firstRoom = rooms[0]?.id;
      if (firstRoom) {
        onChange(appendPanelToColumn(layout, columnId, type, { roomId: firstRoom }));
      } else {
        onPickRoom();
      }
      return;
    }
    onChange(appendPanelToColumn(layout, columnId, type));
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={atMax}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] sm:text-xs font-bold uppercase tracking-wide border-2 border-black bg-oct-accent text-white shadow-oct-hard-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        <Plus size={14} strokeWidth={2.5} />
        Add panel ({panelCount}/{WORKSPACE_MAX_PANELS})
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] border-2 border-black bg-oct-surface shadow-oct-hard py-1">
          {WORKSPACE_WIDGETS.map((w) => (
            <button
              key={w.type}
              type="button"
              onClick={() => handleAdd(w.type)}
              className="w-full text-left px-3 py-2 hover:bg-oct-surface-raised transition-colors"
            >
              <p className="text-xs font-bold uppercase text-oct-text">{w.label}</p>
              <p className="text-[10px] font-mono text-oct-muted mt-0.5">{w.description}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
