import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useAppStore } from '../stores/appStore';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import WorkspaceColumnLayout from '../components/workspace/WorkspaceColumnLayout';
import WorkspaceToolbar from '../components/workspace/WorkspaceToolbar';
import RoomPickerModal from '../components/workspace/RoomPickerModal';
import {
  addColumn,
  appendPanelToColumn,
  createDefaultWorkspaceLayout,
  defaultAddColumnId,
  removePanel,
  resolveWorkspaceLayout,
  updatePanelConfig,
} from '../data/workspaceWidgets';
import { routes } from '../lib/routes';
import type { WorkspaceLayout, WorkspacePanelSlot } from '../types/workspace';

type RoomPickTarget =
  | { mode: 'configure'; panelId: string }
  | { mode: 'add' }
  | null;

export default function WorkspacePage() {
  const { isAuthenticated, ready } = useAuthSession();
  const config = useAppStore((s) => s.config);
  const rooms = useAppStore((s) => s.rooms);
  const updateConfig = useAppStore((s) => s.updateConfig);

  const firstRoomId = rooms[0]?.id;

  const savedLayout = useMemo(
    () => resolveWorkspaceLayout(config?.workspaceLayout, firstRoomId),
    [config?.workspaceLayout, firstRoomId],
  );

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<WorkspaceLayout>(savedLayout);
  const [saving, setSaving] = useState(false);
  const [roomPick, setRoomPick] = useState<RoomPickTarget>(null);

  useEffect(() => {
    if (!editMode) setDraft(savedLayout);
  }, [editMode, savedLayout]);

  const layout = editMode ? draft : savedLayout;

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateConfig({ workspaceLayout: draft });
      setEditMode(false);
    } finally {
      setSaving(false);
    }
  }, [draft, updateConfig]);

  const handleCancel = () => {
    setDraft(savedLayout);
    setEditMode(false);
  };

  const handleReset = () => {
    setDraft(createDefaultWorkspaceLayout(firstRoomId));
  };

  const handleRemovePanel = (panelId: string) => {
    setDraft((prev) => removePanel(prev, panelId));
  };

  const handleConfigurePanel = (panel: WorkspacePanelSlot) => {
    setRoomPick({ mode: 'configure', panelId: panel.id });
  };

  const handleRoomSelect = (roomId: string) => {
    if (!roomPick) return;
    if (roomPick.mode === 'configure') {
      setDraft((prev) => updatePanelConfig(prev, roomPick.panelId, { roomId }));
    } else if (roomPick.mode === 'add') {
      setDraft((prev) =>
        appendPanelToColumn(prev, defaultAddColumnId(prev), 'room', { roomId }),
      );
    }
    setRoomPick(null);
  };

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-full bg-oct-bg">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={LayoutGrid}
        eyebrow="[ WORKSPACE ]"
        title="Sign in to customize"
        description="Build your own multi-feed dashboard — room streams, contract feed, radar, and FOMO live in one view."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-oct-bg">
      <WorkspaceToolbar
        layout={layout}
        editMode={editMode}
        saving={saving}
        onStartEdit={() => {
          setDraft(savedLayout);
          setEditMode(true);
        }}
        onCancel={handleCancel}
        onSave={handleSave}
        onReset={handleReset}
        onLayoutChange={setDraft}
        onPickRoom={() => setRoomPick({ mode: 'add' })}
        onAddColumn={() => setDraft((prev) => addColumn(prev))}
      />
      <WorkspaceColumnLayout
        layout={layout}
        editMode={editMode}
        onChange={setDraft}
        onRemovePanel={handleRemovePanel}
        onConfigurePanel={handleConfigurePanel}
      />
      <RoomPickerModal
        open={roomPick !== null}
        selectedRoomId={
          roomPick?.mode === 'configure'
            ? findPanel(draft, roomPick.panelId)?.config?.roomId
            : undefined
        }
        onSelect={handleRoomSelect}
        onClose={() => setRoomPick(null)}
      />
      {editMode && (
        <div className="shrink-0 px-4 py-2 border-t-2 border-black bg-black/80 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-oct-muted">
            Drag panel headers to reorder · drag splitters to resize · fits your screen
          </p>
        </div>
      )}
    </div>
  );
}

function findPanel(layout: WorkspaceLayout, panelId: string): WorkspacePanelSlot | undefined {
  for (const col of layout.columns) {
    const p = col.panels.find((x) => x.id === panelId);
    if (p) return p;
  }
  return undefined;
}
