import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useAppStore } from '../stores/appStore';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import WorkspaceGrid from '../components/workspace/WorkspaceGrid';
import WorkspaceToolbar from '../components/workspace/WorkspaceToolbar';
import RoomPickerModal from '../components/workspace/RoomPickerModal';
import {
  createDefaultWorkspaceLayout,
  resolveWorkspaceLayout,
  appendWorkspacePanel,
} from '../data/workspaceWidgets';
import { routes } from '../lib/routes';
import type { WorkspacePanel } from '../types/workspace';

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
  const [draft, setDraft] = useState<WorkspacePanel[]>(savedLayout);
  const [saving, setSaving] = useState(false);
  const [roomPick, setRoomPick] = useState<RoomPickTarget>(null);

  useEffect(() => {
    if (!editMode) setDraft(savedLayout);
  }, [editMode, savedLayout]);

  const panels = editMode ? draft : savedLayout;

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

  const handleRemove = (id: string) => {
    setDraft((prev) => prev.filter((p) => p.id !== id));
  };

  const handleConfigure = (panel: WorkspacePanel) => {
    setRoomPick({ mode: 'configure', panelId: panel.id });
  };

  const handleRoomSelect = (roomId: string) => {
    if (!roomPick) return;
    if (roomPick.mode === 'configure') {
      setDraft((prev) =>
        prev.map((p) =>
          p.id === roomPick.panelId ? { ...p, config: { ...p.config, roomId } } : p,
        ),
      );
    } else if (roomPick.mode === 'add') {
      setDraft((prev) => appendWorkspacePanel(prev, 'room', { roomId }));
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
        editMode={editMode}
        panels={panels}
        saving={saving}
        onStartEdit={() => {
          setDraft(savedLayout);
          setEditMode(true);
        }}
        onCancel={handleCancel}
        onSave={handleSave}
        onReset={handleReset}
        onPanelsChange={setDraft}
        onPickRoom={() => setRoomPick({ mode: 'add' })}
      />
      <WorkspaceGrid
        panels={panels}
        editMode={editMode}
        onChange={setDraft}
        onRemove={handleRemove}
        onConfigure={handleConfigure}
      />
      <RoomPickerModal
        open={roomPick !== null}
        selectedRoomId={
          roomPick?.mode === 'configure'
            ? draft.find((p) => p.id === roomPick.panelId)?.config?.roomId
            : undefined
        }
        onSelect={handleRoomSelect}
        onClose={() => setRoomPick(null)}
      />
      {editMode && (
        <div className="shrink-0 px-4 py-2 border-t-2 border-black bg-black/80 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-oct-muted">
            Drag panels to rearrange · resize from corners · save when done
          </p>
        </div>
      )}
    </div>
  );
}
