import ChatPane from '../ChatPane';
import ContractDashboard from '../ContractDashboard';
import RadarTable from '../callers/RadarTable';
import FomoTradeFeed from '../fomo/FomoTradeFeed';
import WorkspaceFomoLeaderboard from './WorkspaceFomoLeaderboard';
import type { WorkspacePanelSlot } from '../../types/workspace';

interface PanelContentProps {
  panel: WorkspacePanelSlot;
}

export default function PanelContent({ panel }: PanelContentProps) {
  const roomId = panel.config?.roomId;

  const content = (() => {
    switch (panel.type) {
      case 'room':
        if (!roomId) {
          return (
            <div className="flex items-center justify-center h-full p-6 text-center">
              <p className="text-sm text-oct-muted font-mono">Pick a room in panel settings</p>
            </div>
          );
        }
        return (
          <ChatPane
            roomId={roomId}
            paneIndex={0}
            paneCount={1}
            editMode={false}
            variant="workspace"
          />
        );
      case 'contracts':
        return <ContractDashboard embedded />;
      case 'radar':
        return <RadarTable embedded />;
      case 'fomo-feed':
        return <FomoTradeFeed embedded />;
      case 'fomo-leaderboard':
        return <WorkspaceFomoLeaderboard />;
      default:
        return null;
    }
  })();

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {content}
    </div>
  );
}

export function panelSubtitle(panel: WorkspacePanelSlot, roomName: string | null): string | null {
  if (panel.type === 'room' && roomName) return roomName;
  if (panel.type === 'contracts') return 'Live detections';
  if (panel.type === 'radar') return 'Token radar';
  if (panel.type === 'fomo-feed') return 'Tracked traders';
  if (panel.type === 'fomo-leaderboard') return 'Top traders';
  return null;
}
