import { Fragment, useCallback, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import WorkspacePanelChrome from './WorkspacePanelChrome';
import { countPanels, movePanel } from '../../data/workspaceWidgets';
import type {
  WorkspaceColumn,
  WorkspaceLayout,
  WorkspacePanelConfig,
  WorkspacePanelSlot,
} from '../../types/workspace';

interface WorkspaceColumnLayoutProps {
  layout: WorkspaceLayout;
  editMode: boolean;
  onChange: (layout: WorkspaceLayout) => void;
  onRemovePanel: (panelId: string) => void;
  onConfigurePanel: (panel: WorkspacePanelSlot) => void;
  onPanelRoomChange: (panelId: string, roomId: string) => void;
  onPanelConfigChange: (panelId: string, config: Partial<WorkspacePanelConfig>) => void;
}

const H_HANDLE = (editMode: boolean) =>
  `w-1.5 bg-oct-border transition-colors shrink-0 ${editMode ? 'hover:bg-oct-accent cursor-col-resize' : 'opacity-50'}`;
const V_HANDLE = (editMode: boolean) =>
  `h-1.5 bg-oct-border transition-colors shrink-0 ${editMode ? 'hover:bg-oct-accent cursor-row-resize' : 'opacity-50'}`;

export default function WorkspaceColumnLayout({
  layout,
  editMode,
  onChange,
  onRemovePanel,
  onConfigurePanel,
  onPanelRoomChange,
  onPanelConfigChange,
}: WorkspaceColumnLayoutProps) {
  const { columns } = layout;
  const colCount = columns.length;
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const handleDropOnColumn = useCallback(
    (columnId: string, e: React.DragEvent) => {
      e.preventDefault();
      setDragOverColumn(null);
      const raw = e.dataTransfer.getData('text/plain');
      if (!raw.startsWith('panel:')) return;
      const panelId = raw.slice(6);
      onChange(movePanel(layout, panelId, columnId));
    },
    [layout, onChange],
  );

  if (colCount === 0 || countPanels(layout) === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-0 border border-dashed border-oct-border-bright m-roomy rounded-oct-lg">
        <p className="type-title uppercase text-oct-text mb-snug">No panels yet</p>
        <p className="type-caption font-mono text-oct-muted">
          {editMode ? 'Add panels from the toolbar' : 'Customize layout to add widgets'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <PanelGroup
        direction="horizontal"
        autoSaveId="oct-workspace-cols"
        className="flex-1 min-h-0"
      >
        {columns.map((column, ci) => (
          <Fragment key={column.id}>
            {ci > 0 && (
              <PanelResizeHandle
                disabled={!editMode}
                className={H_HANDLE(editMode)}
              />
            )}
            <Panel
              id={column.id}
              order={ci}
              minSize={15}
              defaultSize={100 / colCount}
            >
              <ColumnStack
                column={column}
                editMode={editMode}
                dragOver={dragOverColumn === column.id}
                onDragOverColumn={() => setDragOverColumn(column.id)}
                onDragLeaveColumn={() => setDragOverColumn(null)}
                onDropOnColumn={(e) => handleDropOnColumn(column.id, e)}
                onRemovePanel={onRemovePanel}
                onConfigurePanel={onConfigurePanel}
                onPanelRoomChange={onPanelRoomChange}
                onPanelConfigChange={onPanelConfigChange}
                onMovePanel={(panelId, toIndex) =>
                  onChange(movePanel(layout, panelId, column.id, toIndex))
                }
              />
            </Panel>
          </Fragment>
        ))}
      </PanelGroup>
    </div>
  );
}

interface ColumnStackProps {
  column: WorkspaceColumn;
  editMode: boolean;
  dragOver: boolean;
  onDragOverColumn: () => void;
  onDragLeaveColumn: () => void;
  onDropOnColumn: (e: React.DragEvent) => void;
  onRemovePanel: (panelId: string) => void;
  onConfigurePanel: (panel: WorkspacePanelSlot) => void;
  onPanelRoomChange: (panelId: string, roomId: string) => void;
  onPanelConfigChange: (panelId: string, config: Partial<WorkspacePanelConfig>) => void;
  onMovePanel: (panelId: string, toIndex: number) => void;
}

function ColumnStack({
  column,
  editMode,
  dragOver,
  onDragOverColumn,
  onDragLeaveColumn,
  onDropOnColumn,
  onRemovePanel,
  onConfigurePanel,
  onPanelRoomChange,
  onPanelConfigChange,
  onMovePanel,
}: ColumnStackProps) {
  const panelCount = column.panels.length;
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    if (!editMode) return;
    e.preventDefault();
    onDragOverColumn();
  };

  const handleDrop = (e: React.DragEvent, index?: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDropIndex(null);
    onDragLeaveColumn();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw.startsWith('panel:')) return;
    const panelId = raw.slice(6);
    onMovePanel(panelId, index ?? panelCount);
  };

  if (panelCount === 0) {
    return (
      <div
        className={`h-full min-h-0 flex items-center justify-center border border-dashed rounded-oct m-tight transition-colors duration-fast ${
          dragOver ? 'border-oct-accent bg-oct-accent/5' : 'border-oct-border-bright'
        } ${editMode ? '' : 'opacity-50'}`}
        onDragOver={handleDragOver}
        onDragLeave={onDragLeaveColumn}
        onDrop={(e) => onDropOnColumn(e)}
      >
        {editMode && (
          <p className="type-caption font-mono text-oct-muted uppercase tracking-wide">Drop panel here</p>
        )}
      </div>
    );
  }

  if (panelCount === 1) {
    const panel = column.panels[0];
    return (
      <div
        className={`h-full min-h-0 p-hair ${dragOver ? 'ring-2 ring-inset ring-oct-accent/30' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={onDragLeaveColumn}
        onDrop={(e) => handleDrop(e, 0)}
      >
        <WorkspacePanelChrome
          panel={panel}
          editMode={editMode}
          onRemove={() => onRemovePanel(panel.id)}
          onConfigure={() => onConfigurePanel(panel)}
          onRoomChange={(roomId) => onPanelRoomChange(panel.id, roomId)}
          onConfigChange={(config) => onPanelConfigChange(panel.id, config)}
        />
      </div>
    );
  }

  return (
    <PanelGroup
      direction="vertical"
      autoSaveId={`oct-workspace-col-${column.id}`}
      className="h-full min-h-0"
    >
      {column.panels.map((panel, pi) => (
        <Fragment key={panel.id}>
          {pi > 0 && (
            <PanelResizeHandle
              disabled={!editMode}
              className={V_HANDLE(editMode)}
            />
          )}
          {editMode && dropIndex === pi && (
            <div className="h-1 bg-oct-accent shrink-0" />
          )}
          <Panel
            id={panel.id}
            order={pi}
            minSize={12}
            defaultSize={100 / panelCount}
          >
            <div
              className="h-full min-h-0 p-hair"
              onDragOver={(e) => {
                if (!editMode) return;
                e.preventDefault();
                setDropIndex(pi);
              }}
              onDragLeave={() => setDropIndex(null)}
              onDrop={(e) => handleDrop(e, pi)}
            >
              <WorkspacePanelChrome
                panel={panel}
                editMode={editMode}
                onRemove={() => onRemovePanel(panel.id)}
                onConfigure={() => onConfigurePanel(panel)}
                onRoomChange={(roomId) => onPanelRoomChange(panel.id, roomId)}
                onConfigChange={(config) => onPanelConfigChange(panel.id, config)}
              />
            </div>
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
