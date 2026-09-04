import { useAppStore } from '../../stores/appStore';
import { docsUrl } from '../../lib/links';
import SurfaceEmptyState from './SurfaceEmptyState';

// Workspace with zero panels, outside edit mode. The one action drops the user
// straight into "add a room panel" (edit mode + room picker in one click)
// rather than at the toolbar, which is where the old dashed placeholder sent
// them. With no rooms at all the picker would be empty, so the action becomes
// creating one — the same room-config modal Feed uses.
export default function WorkspaceEmptyState({ onAddRoomPanel }: { onAddRoomPanel: () => void }) {
  const hasRooms = useAppStore((s) => s.rooms.length > 0);
  const openConfigModal = useAppStore((s) => s.openConfigModal);

  return (
    <SurfaceEmptyState
      eyebrow="[ WORKSPACE ]"
      title="No panels"
      body={
        hasRooms
          ? 'Workspace is a grid you compose yourself: room streams, the contract feed, radar and FOMO side by side, resized and reordered to fit your screen.'
          : 'Workspace is a grid you compose yourself: room streams, the contract feed, radar and FOMO side by side. It needs at least one room to show.'
      }
      primary={
        hasRooms
          ? { label: 'Add a room panel', onClick: onAddRoomPanel }
          : { label: 'Create a room', onClick: () => openConfigModal() }
      }
      secondary={{ label: 'About Workspace', href: docsUrl('portfolio/workspace') }}
    />
  );
}
