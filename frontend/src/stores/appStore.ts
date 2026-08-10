import { create } from 'zustand';
import { createAuthSlice, type AuthSlice } from './slices/authSlice';
import { createRoomsSlice, type RoomsSlice } from './slices/roomsSlice';
import { createLayoutSlice, type LayoutSlice } from './slices/layoutSlice';
import { createMessagesSlice, type MessagesSlice } from './slices/messagesSlice';
import { createAlertsSlice, type AlertsSlice } from './slices/alertsSlice';
import { createContractsSlice, type ContractsSlice } from './slices/contractsSlice';
import { createConfigSlice, type ConfigSlice } from './slices/configSlice';
import { createSourcesSlice, type SourcesSlice } from './slices/sourcesSlice';
import { createFomoSlice, type FomoSlice } from './slices/fomoSlice';
import { createRevivalSlice, type RevivalSlice } from './slices/revivalSlice';

export { IS_POPOUT } from './appStore.helpers';

export type AppState = AuthSlice &
  RoomsSlice &
  LayoutSlice &
  MessagesSlice &
  AlertsSlice &
  ContractsSlice &
  ConfigSlice &
  SourcesSlice &
  FomoSlice &
  RevivalSlice;

export const useAppStore = create<AppState>()((...a) => ({
  ...createAuthSlice(...a),
  ...createRoomsSlice(...a),
  ...createLayoutSlice(...a),
  ...createMessagesSlice(...a),
  ...createAlertsSlice(...a),
  ...createContractsSlice(...a),
  ...createConfigSlice(...a),
  ...createSourcesSlice(...a),
  ...createFomoSlice(...a),
  ...createRevivalSlice(...a),
}));
