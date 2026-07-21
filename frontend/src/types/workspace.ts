export type WorkspacePanelType =
  | 'room'
  | 'contracts'
  | 'radar'
  | 'fomo-feed'
  | 'fomo-leaderboard';

export interface WorkspacePanelConfig {
  roomId?: string;
}

export interface WorkspacePanel {
  id: string;
  type: WorkspacePanelType;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: WorkspacePanelConfig;
}
