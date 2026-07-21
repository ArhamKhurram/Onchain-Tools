import { Check, LayoutGrid, Pencil, RotateCcw, X } from 'lucide-react';
import WidgetPicker from './WidgetPicker';
import type { WorkspacePanel } from '../../types/workspace';

interface WorkspaceToolbarProps {
  editMode: boolean;
  panels: WorkspacePanel[];
  saving: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onReset: () => void;
  onPanelsChange: (panels: WorkspacePanel[]) => void;
  onPickRoom: () => void;
}

export default function WorkspaceToolbar({
  editMode,
  panels,
  saving,
  onStartEdit,
  onCancel,
  onSave,
  onReset,
  onPanelsChange,
  onPickRoom,
}: WorkspaceToolbarProps) {
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5 border-b-2 border-black bg-oct-surface">
      <LayoutGrid size={16} className="text-oct-accent shrink-0" />
      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-oct-muted hidden sm:inline">
        Workspace
      </span>
      <div className="flex-1" />
      {editMode ? (
        <>
          <WidgetPicker panels={panels} onAdd={onPanelsChange} onPickRoom={onPickRoom} />
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
