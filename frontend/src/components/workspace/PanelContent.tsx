import ChatPane from '../ChatPane';
import ContractDashboard from '../ContractDashboard';
import RadarTable from '../callers/RadarTable';
import FomoTradeFeed from '../fomo/FomoTradeFeed';
import WorkspaceFomoLeaderboard from './WorkspaceFomoLeaderboard';
import FomoHoldersLookup from '../fomo/FomoHoldersLookup';
import PumpCallersTab from '../pumpfun/PumpCallersTab';
import PumpCalloutFeed from '../pumpfun/PumpCalloutFeed';
import PumpTopCallersTab from '../pumpfun/PumpTopCallersTab';
import WorkspacePumpLeaderboard from './WorkspacePumpLeaderboard';
import type { WorkspacePanelSlot } from '../../types/workspace';

interface PanelContentProps {
  panel: WorkspacePanelSlot;
  onRoomChange: (roomId: string) => void;
}

export default function PanelContent({ panel, onRoomChange }: PanelContentProps) {
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
            onRoomChange={onRoomChange}
          />
        );
      case 'contracts':
        return <ContractDashboard embedded />;
      case 'top-callers-feed':
        return <ContractDashboard embedded topOnly />;
      case 'radar':
        return <RadarTable embedded />;
      case 'fomo-feed':
        return <FomoTradeFeed embedded />;
      case 'fomo-leaderboard':
        return <WorkspaceFomoLeaderboard />;
      case 'token-lookup':
        return <FomoHoldersLookup />;
      case 'pump-following':
        return <PumpCallersTab />;
      case 'pump-callout-feed':
        return <PumpCalloutFeed embedded />;
      case 'pump-top-callers':
        return <PumpTopCallersTab />;
      case 'pump-leaderboard':
        return <WorkspacePumpLeaderboard />;
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
  if (panel.type === 'top-callers-feed') return 'Elite & trusted only';
  if (panel.type === 'radar') return 'Token radar';
  if (panel.type === 'fomo-feed') return 'Tracked traders';
  if (panel.type === 'fomo-leaderboard') return 'Top traders';
  if (panel.type === 'token-lookup') return 'FOMO holders by token';
  if (panel.type === 'pump-following') return 'Followed callers';
  if (panel.type === 'pump-callout-feed') return 'Live callouts';
  if (panel.type === 'pump-top-callers') return 'Top pump callers';
  if (panel.type === 'pump-leaderboard') return 'Top traders';
  return null;
}
