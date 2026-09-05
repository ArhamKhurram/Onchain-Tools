import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useAppStore } from '../stores/appStore';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import WorkspaceEmptyState from '../components/empty/WorkspaceEmptyState';
import WorkspaceColumnLayout from '../components/workspace/WorkspaceColumnLayout';
import WorkspaceToolbar from '../components/workspace/WorkspaceToolbar';
import RoomPickerModal from '../components/workspace/RoomPickerModal';
import FullPageSpinner from '../components/common/FullPageSpinner';
import {
  addColumn,
  appendPanelToColumn,
  countPanels,
  createDefaultWorkspaceLayout,
  defaultAddColumnId,
  removePanel,
  resolveWorkspaceLayout,
  updatePanelConfig,
} from '../data/workspaceWidgets';
import { routes } from '../lib/routes';
import { MotionFeatures, fadeIn, m, useTransition } from '../lib/motion';
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
  // Optimistic copy of an out-of-edit-mode change while its config write is in
  // flight. Dropped the moment the saved layout comes back.
  const [pendingLayout, setPendingLayout] = useState<WorkspaceLayout | null>(null);
  // Page-container entrance only. The panels inside hold virtualised feeds and
  // resizable splitters; none of that animates — see lib/motion.ts.
  const enter = useTransition('fade');

  useEffect(() => {
    if (!editMode) setDraft(savedLayout);
    setPendingLayout(null);
  }, [editMode, savedLayout]);

  const layout = editMode ? draft : (pendingLayout ?? savedLayout);

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

  // Room picked from inside a room panel's own header switcher. In edit mode it
  // joins the unsaved draft like every other layout tweak; outside edit mode it
  // is a live change, so it persists immediately through the same config path
  // the "Save layout" button uses.
  const handlePanelRoomChange = useCallback(
    (panelId: string, roomId: string) => {
      if (editMode) {
        setDraft((prev) => updatePanelConfig(prev, panelId, { roomId }));
        return;
      }
      const next = updatePanelConfig(savedLayout, panelId, { roomId });
      // Show the new room right away; the saved config takes over as soon as the
      // write lands (or we roll back if it fails).
      setPendingLayout(next);
      void updateConfig({ workspaceLayout: next }).catch(() => setPendingLayout(null));
    },
    [editMode, savedLayout, updateConfig],
  );

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
    return <FullPageSpinner />;
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
    <MotionFeatures>
      <m.div
        variants={fadeIn}
        initial="hidden"
        animate="visible"
        transition={enter}
        className="flex flex-col h-full min-h-0 bg-oct-bg"
      >
        <WorkspaceToolbar
          layout={layout}
          editMode={editMode}
          saving={saving}
          onStartEdit={() => {
            // Start from what is on screen, which includes a room switch whose
            // config write may still be in flight.
            setDraft(layout);
            setEditMode(true);
          }}
          onCancel={handleCancel}
          onSave={handleSave}
          onReset={handleReset}
          onLayoutChange={setDraft}
          onPickRoom={() => setRoomPick({ mode: 'add' })}
          onAddColumn={() => setDraft((prev) => addColumn(prev))}
        />
        {!editMode && countPanels(layout) === 0 ? (
          <WorkspaceEmptyState
            onAddRoomPanel={() => {
              // Same entry as the toolbar's Customize, plus the picker in one click.
              setDraft(layout);
              setEditMode(true);
              setRoomPick({ mode: 'add' });
            }}
          />
        ) : (
          <WorkspaceColumnLayout
            layout={layout}
            editMode={editMode}
            onChange={setDraft}
            onRemovePanel={handleRemovePanel}
            onConfigurePanel={handleConfigurePanel}
            onPanelRoomChange={handlePanelRoomChange}
          />
        )}
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
          <div className="oct-headerbar shrink-0 px-comfy py-tight text-center">
            <p className="type-caption font-mono uppercase tracking-wider text-oct-muted">
              Drag panel headers to reorder · drag splitters to resize · fits your screen
            </p>
          </div>
        )}
      </m.div>
    </MotionFeatures>
  );
}

function findPanel(layout: WorkspaceLayout, panelId: string): WorkspacePanelSlot | undefined {
  for (const col of layout.columns) {
    const p = col.panels.find((x) => x.id === panelId);
    if (p) return p;
  }
  return undefined;
}
