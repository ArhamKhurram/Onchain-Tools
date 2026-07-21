export type WorkspacePanelType =
  | 'room'
  | 'contracts'
  | 'radar'
  | 'fomo-feed'
  | 'fomo-leaderboard';

export interface WorkspacePanelConfig {
  roomId?: string;
}

/** A widget slot inside a column stack. */
export interface WorkspacePanelSlot {
  id: string;
  type: WorkspacePanelType;
  config?: WorkspacePanelConfig;
}

export interface WorkspaceColumn {
  id: string;
  panels: WorkspacePanelSlot[];
}

/** Column-stack layout (v2) — fills viewport, resizable splits. */
export interface WorkspaceLayout {
  version: 2;
  columns: WorkspaceColumn[];
}

/** Legacy free-grid panel (v1) — migrated on load. */
export interface WorkspacePanelLegacy {
  id: string;
  type: WorkspacePanelType;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: WorkspacePanelConfig;
}

export type WorkspaceLayoutPersisted = WorkspaceLayout | WorkspacePanelLegacy[];
