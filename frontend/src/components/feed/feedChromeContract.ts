import { createContext, useContext } from 'react';
import type { Room } from '../../types';

/** Every layout the Feed chrome can wear. Adding one here forces every
 *  exhaustive map/switch over the union to be updated. */
export type FeedChromePreset = 'terminal' | 'masthead' | 'rail';

export const DEFAULT_FEED_CHROME_PRESET: FeedChromePreset = 'terminal';

export interface FeedChromeEntry {
  id: string;
  label: string;
  kind: 'mentions' | 'room';
  unread: number;
  /** Already open in one of the panes. */
  active: boolean;
}

/** Everything a preset needs, derived once so presets stay pure layout. */
export interface FeedChromeModel {
  preset: FeedChromePreset;
  rooms: Room[];
  entries: FeedChromeEntry[];
  activeRoom: Room | undefined;
  activeRoomId: string | null;
  /** Display label for the focused pane, e.g. `#ALPHA` / `@MENTIONS`. */
  activeLabel: string;
  channelCount: number;
  paneRoomIds: string[];
  activePaneIndex: number;
  paneCount: number;
  contractCount: number;
  highlightCount: number;
  unreadTotal: number;
  discordConnected: boolean;
  telegramConfigured: boolean;
  telegramConnected: boolean;
  layoutEditMode: boolean;
  selectRoom: (roomId: string) => void;
  createRoom: () => void;
  configureActiveRoom: () => void;
  toggleLayoutEditMode: () => void;
}

export interface FeedChromePresetProps {
  model: FeedChromeModel;
  paletteOpen: boolean;
  onOpenPalette: () => void;
}

export interface FeedChromeCapabilities {
  /** True when the chrome already states which room a pane is showing, so the
   *  pane drops its own identity header and keeps only its local controls. */
  ownsPaneHeader: (paneCount: number) => boolean;
}

const FEED_CHROME_CAPABILITIES: Record<FeedChromePreset, FeedChromeCapabilities> = {
  terminal: { ownsPaneHeader: (paneCount) => paneCount <= 1 },
  masthead: { ownsPaneHeader: (paneCount) => paneCount <= 1 },
  rail: { ownsPaneHeader: (paneCount) => paneCount <= 1 },
};

export function chromeOwnsPaneHeader(preset: FeedChromePreset, paneCount: number): boolean {
  return FEED_CHROME_CAPABILITIES[preset].ownsPaneHeader(paneCount);
}

export interface FeedChromeContextValue {
  preset: FeedChromePreset;
  ownsPaneHeader: boolean;
}

/** Provided by the Feed shell only. Panes rendered anywhere else (popout,
 *  workspace) read `null` and keep their full header. */
export const FeedChromeContext = createContext<FeedChromeContextValue | null>(null);

export function useFeedChromeContext(): FeedChromeContextValue | null {
  return useContext(FeedChromeContext);
}
