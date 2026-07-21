import { useCallback, useMemo } from 'react';
import ReactGridLayout, { WidthProvider, type Layout } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import WorkspacePanelChrome from './WorkspacePanelChrome';
import {
  WORKSPACE_COLS,
  WORKSPACE_ROW_HEIGHT,
  panelsToGridLayout,
  mergeGridLayout,
} from '../../data/workspaceWidgets';
import type { WorkspacePanel } from '../../types/workspace';

const AutoGrid = WidthProvider(ReactGridLayout);

interface WorkspaceGridProps {
  panels: WorkspacePanel[];
  editMode: boolean;
  onChange: (panels: WorkspacePanel[]) => void;
  onRemove: (id: string) => void;
  onConfigure: (panel: WorkspacePanel) => void;
}

export default function WorkspaceGrid({
  panels,
  editMode,
  onChange,
  onRemove,
  onConfigure,
}: WorkspaceGridProps) {
  const layout = useMemo(() => panelsToGridLayout(panels), [panels]);

  const handleLayoutChange = useCallback(
    (next: Layout) => {
      if (!editMode) return;
      onChange(mergeGridLayout(panels, [...next]));
    },
    [editMode, onChange, panels],
  );

  if (panels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[320px] border-2 border-dashed border-oct-border-bright m-4 rounded-cockpit">
        <p className="text-oct-text font-bold uppercase mb-1">No panels yet</p>
        <p className="text-sm text-oct-muted font-mono">Customize layout and add widgets to get started</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto p-2 sm:p-3">
      <AutoGrid
        className="layout"
        layout={layout}
        cols={WORKSPACE_COLS}
        rowHeight={WORKSPACE_ROW_HEIGHT}
        margin={[8, 8] as const}
        containerPadding={[0, 0] as const}
        isDraggable={editMode}
        isResizable={editMode}
        draggableHandle=".workspace-drag-handle"
        compactType={null}
        preventCollision={false}
        onLayoutChange={handleLayoutChange}
      >
        {panels.map((panel) => (
          <div key={panel.id}>
            <WorkspacePanelChrome
              panel={panel}
              editMode={editMode}
              onRemove={() => onRemove(panel.id)}
              onConfigure={() => onConfigure(panel)}
            />
          </div>
        ))}
      </AutoGrid>
    </div>
  );
}
