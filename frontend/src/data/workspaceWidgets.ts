import type {
  WorkspaceColumn,
  WorkspaceLayout,
  WorkspaceLayoutPersisted,
  WorkspacePanelConfig,
  WorkspacePanelLegacy,
  WorkspacePanelSlot,
  WorkspacePanelType,
} from '../types/workspace';

export const WORKSPACE_MAX_PANELS = 6;
export const WORKSPACE_MAX_COLUMNS = 3;

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

function newPanelId(): string {
  return `ws-${crypto.randomUUID().slice(0, 8)}`;
}

function newColumnId(): string {
  return `col-${crypto.randomUUID().slice(0, 8)}`;
}

function isLegacyGrid(saved: WorkspaceLayoutPersisted): saved is WorkspacePanelLegacy[] {
  return Array.isArray(saved) && saved.length > 0 && 'x' in saved[0];
}

function isV2Layout(saved: WorkspaceLayoutPersisted): saved is WorkspaceLayout {
  return !Array.isArray(saved) && saved?.version === 2 && Array.isArray(saved.columns);
}

/** Migrate v1 grid coordinates into column stacks (left/right split at col 6). */
export function migrateGridToColumns(panels: WorkspacePanelLegacy[]): WorkspaceLayout {
  const sorted = [...panels].sort((a, b) => a.x - b.x || a.y - b.y);
  const left = sorted.filter((p) => p.x < 6);
  const right = sorted.filter((p) => p.x >= 6);

  const toSlot = (p: WorkspacePanelLegacy): WorkspacePanelSlot => ({
    id: p.id,
    type: p.type,
    config: p.config,
  });

  const columns: WorkspaceColumn[] = [];
  if (left.length > 0) {
    columns.push({ id: 'col-left', panels: left.map(toSlot) });
  }
  if (right.length > 0) {
    columns.push({ id: 'col-right', panels: right.map(toSlot) });
  }
  if (columns.length === 0) {
    columns.push({ id: 'col-1', panels: [] });
  }
  return { version: 2, columns };
}

export function createDefaultWorkspaceLayout(firstRoomId?: string): WorkspaceLayout {
  const rightPanels: WorkspacePanelSlot[] = [
    { id: 'ws-contracts', type: 'contracts' },
    { id: 'ws-radar', type: 'radar' },
    { id: 'ws-fomo', type: 'fomo-feed' },
  ];

  const columns: WorkspaceColumn[] = [
    {
      id: 'col-main',
      panels: firstRoomId
        ? [{ id: 'ws-room', type: 'room', config: { roomId: firstRoomId } }]
        : [],
    },
    { id: 'col-stack', panels: rightPanels },
  ];

  if (!firstRoomId) {
    return {
      version: 2,
      columns: [{ id: 'col-stack', panels: rightPanels }],
    };
  }

  return { version: 2, columns };
}

export function resolveWorkspaceLayout(
  saved: WorkspaceLayoutPersisted | undefined | null,
  firstRoomId?: string,
): WorkspaceLayout {
  if (saved && isV2Layout(saved) && saved.columns.some((c) => c.panels.length > 0)) {
    return saved;
  }
  if (saved && isLegacyGrid(saved)) {
    return migrateGridToColumns(saved);
  }
  return createDefaultWorkspaceLayout(firstRoomId);
}

export function countPanels(layout: WorkspaceLayout): number {
  return layout.columns.reduce((n, c) => n + c.panels.length, 0);
}

export function appendPanelToColumn(
  layout: WorkspaceLayout,
  columnId: string | null,
  type: WorkspacePanelType,
  config?: WorkspacePanelConfig,
): WorkspaceLayout {
  if (countPanels(layout) >= WORKSPACE_MAX_PANELS) return layout;
  const targetId = columnId ?? layout.columns[layout.columns.length - 1]?.id;
  if (!targetId) return layout;

  const panel: WorkspacePanelSlot = { id: newPanelId(), type, config };
  return {
    version: 2,
    columns: layout.columns.map((col) =>
      col.id === targetId ? { ...col, panels: [...col.panels, panel] } : col,
    ),
  };
}

export function removePanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  const columns = layout.columns
    .map((col) => ({
      ...col,
      panels: col.panels.filter((p) => p.id !== panelId),
    }))
    .filter((col) => col.panels.length > 0 || layout.columns.length === 1);

  return {
    version: 2,
    columns: columns.length > 0 ? columns : [{ id: newColumnId(), panels: [] }],
  };
}

export function movePanel(
  layout: WorkspaceLayout,
  panelId: string,
  toColumnId: string,
  toIndex?: number,
): WorkspaceLayout {
  let moving: WorkspacePanelSlot | null = null;
  let fromColumnId: string | null = null;
  let fromIndex = -1;

  for (const col of layout.columns) {
    const idx = col.panels.findIndex((p) => p.id === panelId);
    if (idx !== -1) {
      moving = col.panels[idx];
      fromColumnId = col.id;
      fromIndex = idx;
      break;
    }
  }
  if (!moving) return layout;

  const insertAt = toIndex ?? 999;

  return {
    version: 2,
    columns: layout.columns.map((col) => {
      let panels = col.panels.filter((p) => p.id !== panelId);
      if (col.id === toColumnId) {
        let at = insertAt;
        if (fromColumnId === toColumnId && fromIndex < at) at -= 1;
        at = Math.max(0, Math.min(at, panels.length));
        panels = [...panels.slice(0, at), moving!, ...panels.slice(at)];
      }
      return { ...col, panels };
    }),
  };
}

export function updatePanelConfig(
  layout: WorkspaceLayout,
  panelId: string,
  config: WorkspacePanelConfig,
): WorkspaceLayout {
  return {
    version: 2,
    columns: layout.columns.map((col) => ({
      ...col,
      panels: col.panels.map((p) => (p.id === panelId ? { ...p, config: { ...p.config, ...config } } : p)),
    })),
  };
}

export function addColumn(layout: WorkspaceLayout): WorkspaceLayout {
  if (layout.columns.length >= WORKSPACE_MAX_COLUMNS) return layout;
  return {
    version: 2,
    columns: [...layout.columns, { id: newColumnId(), panels: [] }],
  };
}

export function removeColumn(layout: WorkspaceLayout, columnId: string): WorkspaceLayout {
  if (layout.columns.length <= 1) return layout;
  const target = layout.columns.find((c) => c.id === columnId);
  if (!target) return layout;

  const remaining = layout.columns.filter((c) => c.id !== columnId);
  const fallbackCol = remaining[remaining.length - 1];
  return {
    version: 2,
    columns: remaining.map((col) =>
      col.id === fallbackCol.id
        ? { ...col, panels: [...col.panels, ...target.panels] }
        : col,
    ),
  };
}

/** Rightmost column — default target for new widgets (usually the stack). */
export function defaultAddColumnId(layout: WorkspaceLayout): string | null {
  if (layout.columns.length === 0) return null;
  return layout.columns[layout.columns.length - 1].id;
}
