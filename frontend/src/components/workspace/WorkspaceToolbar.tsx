import { Check, Columns3, LayoutGrid, Pencil, RotateCcw, X } from 'lucide-react';
import WidgetPicker from './WidgetPicker';
import { WORKSPACE_MAX_COLUMNS, countPanels } from '../../data/workspaceWidgets';
import { cn } from '../../lib/utils';
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

// One recipe for every toolbar button so their heights agree: the toolbar is a
// single row and a 1px mismatch between "Column" and "Cancel" reads as sloppy.
// `type-label` (13px/600) replaces the old 11px mono — still a label, now on
// the ramp.
const TOOLBAR_BTN = 'inline-flex items-center gap-tight px-cozy py-tight type-label uppercase tracking-wide';

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
    <div className="oct-headerbar shrink-0 flex flex-wrap items-center gap-cozy px-comfy py-snug">
      <LayoutGrid size={16} className="text-oct-accent shrink-0" />
      <span className="type-label uppercase tracking-wider text-oct-muted hidden sm:inline">
        Workspace
      </span>
      {!editMode && panelCount > 0 && (
        <span className="type-data text-oct-muted">
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
            className={cn('oct-icon-btn', TOOLBAR_BTN)}
            title="Add column"
          >
            <Columns3 size={14} />
            Column
          </button>
          <button
            type="button"
            onClick={onReset}
            className="oct-icon-btn p-tight"
            title="Reset to default layout"
          >
            <RotateCcw size={14} />
          </button>
          <button type="button" onClick={onCancel} className={cn('oct-icon-btn', TOOLBAR_BTN)}>
            <X size={14} />
            Cancel
          </button>
          {/* Save is the one confirming action on the bar, so it carries the
              semantic `good` colour rather than the brand accent — in the dark
              theme the accent is red, which is the wrong signal for "commit". */}
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className={cn(
              TOOLBAR_BTN,
              'rounded-oct-sm border border-oct-good/50 bg-oct-good text-black',
              'shadow-[0_6px_18px_-8px_rgb(var(--oct-good)/0.5)] hover:brightness-105',
              'disabled:opacity-50 transition-all duration-fast',
            )}
          >
            <Check size={14} strokeWidth={2.5} />
            Save
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onStartEdit}
          className={cn('oct-icon-btn hover:!border-oct-accent', TOOLBAR_BTN)}
        >
          <Pencil size={14} />
          Customize
        </button>
      )}
    </div>
  );
}
