import { Settings2, X } from 'lucide-react';
import { widgetLabel } from '../../data/workspaceWidgets';
import PanelContent, { panelSubtitle } from './PanelContent';
import type { WorkspacePanelSlot } from '../../types/workspace';
import { useAppStore } from '../../stores/appStore';
import { useMemo } from 'react';

interface WorkspacePanelChromeProps {
  panel: WorkspacePanelSlot;
  editMode: boolean;
  onRemove: () => void;
  onConfigure: () => void;
}

export default function WorkspacePanelChrome({
  panel,
  editMode,
  onRemove,
  onConfigure,
}: WorkspacePanelChromeProps) {
  const rooms = useAppStore((s) => s.rooms);
  const roomName = useMemo(() => {
    const roomId = panel.config?.roomId;
    if (!roomId) return null;
    if (roomId === 'mentions') return 'Mentions';
    if (roomId.startsWith('dm:')) return 'Direct Message';
    if (roomId.startsWith('tg-dm:')) return 'Telegram DM';
    return rooms.find((r) => r.id === roomId)?.name ?? null;
  }, [panel.config?.roomId, rooms]);

  const subtitle = panelSubtitle(panel, roomName);

  const handleDragStart = (e: React.DragEvent) => {
    if (!editMode) return;
    e.dataTransfer.setData('text/plain', `panel:${panel.id}`);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      className={`flex flex-col h-full min-h-0 bg-oct-bg border-2 border-black overflow-hidden ${
        editMode ? 'ring-2 ring-oct-accent/40' : ''
      }`}
    >
      <div
        draggable={editMode}
        onDragStart={handleDragStart}
        className={`shrink-0 flex items-center gap-2 px-2 py-1.5 border-b-2 border-black bg-oct-surface ${
          editMode ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
      >
        <div className="min-w-0 flex-1 select-none">
          <p className="text-xs font-extrabold uppercase tracking-wide text-oct-text truncate">
            {widgetLabel(panel.type)}
          </p>
          {subtitle && (
            <p className="text-[10px] font-mono text-oct-muted truncate">{subtitle}</p>
          )}
        </div>
        {panel.type === 'room' && editMode && (
          <button
            type="button"
            onClick={onConfigure}
            className="p-1 rounded-cockpit text-oct-muted hover:text-oct-text shrink-0"
            title="Choose room"
          >
            <Settings2 size={14} />
          </button>
        )}
        {editMode && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1 rounded-cockpit text-oct-muted hover:text-oct-accent shrink-0"
            title="Remove panel"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <PanelContent panel={panel} />
      </div>
    </div>
  );
}
