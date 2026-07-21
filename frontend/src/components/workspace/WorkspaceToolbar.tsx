import { Check, Columns3, LayoutGrid, Pencil, RotateCcw, X } from 'lucide-react';
import WidgetPicker from './WidgetPicker';
import { WORKSPACE_MAX_COLUMNS, countPanels } from '../../data/workspaceWidgets';
import type { WorkspaceLayout } from '../../types/workspace';

interface WorkspaceToolbarProps {
  layout: WorkspaceLayout;
  editMode: boolean;
  saving: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onReset: () => void;
  onLayoutChange: (layout: WorkspaceLayout) => void;
  onPickRoom: () => void;
  onAddColumn: () => void;
}

export default function WorkspaceToolbar({
  layout,
  editMode,
  saving,
  onStartEdit,
  onCancel,
  onSave,
  onReset,
  onLayoutChange,
  onPickRoom,
  onAddColumn,
}: WorkspaceToolbarProps) {
  const panelCount = countPanels(layout);
  const canAddColumn = layout.columns.length < WORKSPACE_MAX_COLUMNS;

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5 border-b-2 border-black bg-oct-surface">
      <LayoutGrid size={16} className="text-oct-accent shrink-0" />
      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-oct-muted hidden sm:inline">
        Workspace
      </span>
      {!editMode && panelCount > 0 && (
        <span className="font-mono text-[10px] text-oct-muted tabular-nums">
          {layout.columns.length} col · {panelCount} panels
        </span>
      )}
      <div className="flex-1" />
      {editMode ? (
        <>
          <WidgetPicker layout={layout} onChange={onLayoutChange} onPickRoom={onPickRoom} />
          <button
            type="button"
            onClick={onAddColumn}
            disabled={!canAddColumn}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase border-2 border-oct-border-bright text-oct-muted hover:text-oct-text disabled:opacity-40"
            title="Add column"
          >
            <Columns3 size={14} />
            Column
          </button>
          <button
            type="button"
            onClick={onReset}
            className="p-1.5 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-text"
            title="Reset to default layout"
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase border-2 border-oct-border-bright text-oct-muted hover:text-oct-text"
          >
            <X size={14} />
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase border-2 border-black bg-oct-green text-black shadow-oct-hard-sm disabled:opacity-50"
          >
            <Check size={14} strokeWidth={2.5} />
            Save
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onStartEdit}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] sm:text-xs font-bold uppercase tracking-wide border-2 border-black bg-oct-surface-raised text-oct-text hover:border-oct-accent transition-colors"
        >
          <Pencil size={14} />
          Customize
        </button>
      )}
    </div>
  );
}
