import { Settings2, X } from 'lucide-react';
import { widgetLabel } from '../../data/workspaceWidgets';
import PanelContent, { panelSubtitle } from './PanelContent';
import type { WorkspacePanelSlot } from '../../types/workspace';
import { useAppStore } from '../../stores/appStore';
import { cn } from '../../lib/utils';
import { useMemo } from 'react';

interface WorkspacePanelChromeProps {
  panel: WorkspacePanelSlot;
  editMode: boolean;
  onRemove: () => void;
  onConfigure: () => void;
  onRoomChange: (roomId: string) => void;
}

export default function WorkspacePanelChrome({
  panel,
  editMode,
  onRemove,
  onConfigure,
  onRoomChange,
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
      className={cn(
        'flex flex-col h-full min-h-0 bg-oct-bg rounded-oct border border-oct-border overflow-hidden',
        editMode && 'ring-2 ring-oct-accent/40',
      )}
    >
      {/* One line, not two. A workspace stacks four or five of these per column,
          so the header is paid for on every panel: title and subtitle sit on the
          same baseline separated by a dot, which takes the chrome from ~38px to
          ~26px. `type-title` is the panel-title role; the `text-xs` override is
          the supported "take the role, retune one axis" pattern — 16px bold
          uppercase stacked five high is a heading wall, 13px is a label rail. */}
      <div
        draggable={editMode}
        onDragStart={handleDragStart}
        className={cn(
          'oct-headerbar shrink-0 flex items-center gap-cozy px-cozy py-tight',
          editMode && 'cursor-grab active:cursor-grabbing',
        )}
      >
        <div className="min-w-0 flex-1 flex items-baseline gap-snug select-none">
          <span className="type-title text-xs uppercase tracking-wide text-oct-text truncate">
            {widgetLabel(panel.type)}
          </span>
          {subtitle && (
            <span className="type-caption font-mono text-oct-muted truncate">
              <span aria-hidden="true">· </span>
              {subtitle}
            </span>
          )}
        </div>
        {panel.type === 'room' && editMode && (
          <button
            type="button"
            onClick={onConfigure}
            className="p-tight rounded-oct-sm text-oct-muted hover:text-oct-text shrink-0 transition-colors duration-fast"
            title="Choose room"
          >
            <Settings2 size={14} />
          </button>
        )}
        {editMode && (
          <button
            type="button"
            onClick={onRemove}
            // Removing is destructive, so the hover colour is the semantic
            // `critical` rather than the accent (which is also red in dark, and
            // therefore says "brand" rather than "danger").
            className="p-tight rounded-oct-sm text-oct-muted hover:text-oct-critical shrink-0 transition-colors duration-fast"
            title="Remove panel"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <PanelContent panel={panel} onRoomChange={onRoomChange} />
      </div>
    </div>
  );
}
