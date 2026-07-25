// Workspace layout types now live in @oct/shared (canonical). This module
// re-exports them so existing `../types/workspace` importers keep working.
// isolatedModules is on in the frontend tsconfig, so every re-export here MUST
// use `export type`.
export type {
  WorkspacePanelType,
  WorkspacePanelConfig,
  WorkspacePanelSlot,
  WorkspaceColumn,
  WorkspaceLayout,
  WorkspacePanelLegacy,
  WorkspaceLayoutPersisted,
} from '@oct/shared';
