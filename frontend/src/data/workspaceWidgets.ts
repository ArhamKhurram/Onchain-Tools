import type { WorkspacePanel, WorkspacePanelConfig, WorkspacePanelType } from '../types/workspace';

export const WORKSPACE_MAX_PANELS = 6;
export const WORKSPACE_COLS = 12;
export const WORKSPACE_ROW_HEIGHT = 52;
export const WORKSPACE_DEFAULT_PANEL_H = 8;
export const WORKSPACE_DEFAULT_PANEL_W = 6;

export interface WorkspaceWidgetDef {
  type: WorkspacePanelType;
  label: string;
  description: string;
  needsRoom?: boolean;
}

export const WORKSPACE_WIDGETS: WorkspaceWidgetDef[] = [
  { type: 'room', label: 'Room feed', description: 'Stream a Discord room, DM, or mentions', needsRoom: true },
  { type: 'contracts', label: 'Contract feed', description: 'Detected contract addresses from your channels' },
  { type: 'radar', label: 'Radar', description: 'Token mention aggregation and overlap' },
  { type: 'fomo-feed', label: 'FOMO live', description: 'Live buys and sells from tracked traders' },
  { type: 'fomo-leaderboard', label: 'FOMO leaderboard', description: 'Top traders on fomo.family' },
];

export function widgetLabel(type: WorkspacePanelType): string {
  return WORKSPACE_WIDGETS.find((w) => w.type === type)?.label ?? type;
}

export function createDefaultWorkspaceLayout(firstRoomId?: string): WorkspacePanel[] {
  const panels: WorkspacePanel[] = [
    { id: 'ws-contracts', type: 'contracts', x: 0, y: 0, w: 6, h: 8 },
    { id: 'ws-radar', type: 'radar', x: 6, y: 0, w: 6, h: 8 },
    { id: 'ws-fomo', type: 'fomo-feed', x: 0, y: 8, w: 6, h: 8 },
  ];
  if (firstRoomId) {
    panels.push({
      id: 'ws-room',
      type: 'room',
      x: 6,
      y: 8,
      w: 6,
      h: 8,
      config: { roomId: firstRoomId },
    });
  }
  return panels;
}

export function resolveWorkspaceLayout(
  saved: WorkspacePanel[] | undefined | null,
  firstRoomId?: string,
): WorkspacePanel[] {
  if (Array.isArray(saved) && saved.length > 0) return saved;
  return createDefaultWorkspaceLayout(firstRoomId);
}

export function appendWorkspacePanel(
  panels: WorkspacePanel[],
  type: WorkspacePanelType,
  config?: WorkspacePanelConfig,
): WorkspacePanel[] {
  if (panels.length >= WORKSPACE_MAX_PANELS) return panels;
  const maxY = panels.reduce((m, p) => Math.max(m, p.y + p.h), 0);
  return [
    ...panels,
    {
      id: `ws-${crypto.randomUUID().slice(0, 8)}`,
      type,
      x: 0,
      y: maxY,
      w: WORKSPACE_DEFAULT_PANEL_W,
      h: WORKSPACE_DEFAULT_PANEL_H,
      config,
    },
  ];
}

export function panelsToGridLayout(panels: WorkspacePanel[]) {
  return panels.map((p) => ({
    i: p.id,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    minW: 3,
    minH: 4,
  }));
}

export function mergeGridLayout(
  panels: WorkspacePanel[],
  layout: { i: string; x: number; y: number; w: number; h: number }[],
): WorkspacePanel[] {
  const byId = new Map(layout.map((l) => [l.i, l]));
  return panels.map((p) => {
    const l = byId.get(p.id);
    if (!l) return p;
    return { ...p, x: l.x, y: l.y, w: l.w, h: l.h };
  });
}
