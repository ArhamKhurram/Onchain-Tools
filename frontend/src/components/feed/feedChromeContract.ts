import { createContext, useContext } from 'react';
import type { Room } from '../../types';

/** Every layout the Feed chrome can wear. Adding one here forces every
 *  exhaustive map/switch over the union to be updated. */
export type FeedChromePreset = 'terminal' | 'masthead' | 'rail';

export const DEFAULT_FEED_CHROME_PRESET: FeedChromePreset = 'terminal';

export const FEED_CHROME_PRESETS: readonly FeedChromePreset[] = ['terminal', 'masthead', 'rail'];

/** Short, user-facing name per preset — the in-feed switcher and Settings
 *  both read from here so the two never disagree. */
export const FEED_CHROME_PRESET_LABEL: Record<FeedChromePreset, string> = {
  terminal: 'Terminal',
  masthead: 'Masthead',
  rail: 'Rail',
};

/** Config arrives as a loosely-typed blob (JSON file locally, JSONB hosted), so
 *  an unknown or missing value falls back to the default rather than leaking a
 *  bogus string into an exhaustive lookup. */
export function normalizeFeedChromePreset(value: unknown): FeedChromePreset {
  return FEED_CHROME_PRESETS.includes(value as FeedChromePreset) ? (value as FeedChromePreset) : DEFAULT_FEED_CHROME_PRESET;
}

// ── Row density ───────────────────────────────────────────────────────────────
// A preset is not only chrome: it also decides how tightly the message rows
// beneath it pack. Terminal is the "maximum feed" layout, so its rows are the
// tightest; masthead is editorial and breathes; rail keeps today's spacing.
//
// Density reaches the rows as ONE prop computed at the pane level (ChatPane
// reads the chrome context once), never as a context read per row — the rows
// are virtualised and re-render per WebSocket frame, so anything they resolve
// themselves is paid thousands of times.

export type FeedRowDensity = 'compact' | 'default' | 'comfortable';

export const DEFAULT_FEED_ROW_DENSITY: FeedRowDensity = 'default';

export const FEED_PRESET_DENSITY: Record<FeedChromePreset, FeedRowDensity> = {
  terminal: 'compact',
  masthead: 'comfortable',
  rail: 'default',
};

/** First-guess row height for the virtualiser, per density. Rows are measured
 *  for real once mounted (VirtualMessageList), so this only has to be close
 *  enough that the scrollbar and jump targets don't lurch as rows appear. The
 *  default (48) is the historical single-value estimate. */
export const FEED_ROW_HEIGHT_ESTIMATE: Record<FeedRowDensity, number> = {
  compact: 36,
  default: 48,
  comfortable: 56,
};

/**
 * Tailwind class fragments per density, split by the three row shapes Message
 * renders (compact display mode, same-author continuation, and the full row
 * with avatar + author line). `default` reproduces the pre-density classes
 * byte-for-byte so the rail preset — and every pane outside the Feed shell —
 * renders exactly as before.
 *
 * A static table rather than a function: Message looks up one object per
 * render and never allocates a class string.
 */
export interface FeedRowDensityStyle {
  /** Vertical padding of a compact-display-mode row. */
  compactPad: string;
  /** Vertical padding of a same-author continuation row. */
  contPad: string;
  /** Vertical padding of a full row (avatar + author line). */
  firstPad: string;
  /** Line height shared by the row's min-height, timestamp gutter and body. */
  lead: string;
  /** Row min-height, paired with `lead`. */
  minH: string;
  /** Body text of a compact-display-mode row. */
  compactText: string;
  /** Body text of continuation and full rows. */
  text: string;
  /** Avatar offset from the top of a full row, tracking `firstPad`. */
  avatarTop: string;
}

export const FEED_ROW_DENSITY_STYLE: Record<FeedRowDensity, FeedRowDensityStyle> = {
  compact: {
    compactPad: 'py-0',
    contPad: 'py-0',
    firstPad: 'pt-comfy pb-0',
    lead: 'leading-[1.125rem]',
    minH: 'min-h-[1.125rem]',
    compactText: 'text-xs',
    text: 'text-xs',
    avatarTop: 'top-[0.875rem]',
  },
  default: {
    compactPad: 'py-[1px]',
    contPad: 'py-[2px]',
    firstPad: 'pt-[1.0625rem] pb-[2px]',
    lead: 'leading-[1.375rem]',
    minH: 'min-h-[1.375rem]',
    compactText: 'text-[0.9375rem]',
    text: 'text-base',
    avatarTop: 'top-[1.1875rem]',
  },
  comfortable: {
    compactPad: 'py-tight',
    contPad: 'py-tight',
    firstPad: 'pt-section pb-tight',
    lead: 'leading-6',
    minH: 'min-h-6',
    compactText: 'text-base',
    text: 'text-base',
    avatarTop: 'top-[1.625rem]',
  },
};

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
  /** Persist a different chrome preset — the same config write Settings makes. */
  setPreset: (preset: FeedChromePreset) => void;
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
  /** Row density the preset asks for. Panes read it ONCE and pass it down. */
  density: FeedRowDensity;
}

/** Provided by the Feed shell only. Panes rendered anywhere else (popout,
 *  workspace) read `null` and keep their full header. */
export const FeedChromeContext = createContext<FeedChromeContextValue | null>(null);

export function useFeedChromeContext(): FeedChromeContextValue | null {
  return useContext(FeedChromeContext);
}
