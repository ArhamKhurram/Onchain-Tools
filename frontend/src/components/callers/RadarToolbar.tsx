// The Radar's header bar: time-window filter, the settings popover, the
// muted-only reveal, row count and bulk refresh. Chrome only — nothing in
// here is on the per-row render path, so it is the one part of the Radar
// that may carry a transition.
import { RefreshCw, Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { RadarMultipleEmojiRule } from '@oct/shared';
import RadarSettings, { type MentionWindow } from './RadarSettings';
import type { RadarColumnId } from './radarColumns';
import type { RadarWindowFilter } from './radarSort';
import {
  RADAR_PILL_CLASS,
  RADAR_PILL_OFF_CLASS,
  RADAR_PILL_ON_CLASS,
  RADAR_PILL_OUTLINE_CLASS,
} from './radarPills';

const WINDOW_FILTERS: readonly RadarWindowFilter[] = ['1h', '4h', '24h', 'all'];

export interface RadarToolbarProps {
  windowFilter: RadarWindowFilter;
  onWindowFilterChange: (w: RadarWindowFilter) => void;
  mentionWindow: MentionWindow;
  onMentionWindowChange: (w: MentionWindow) => void;
  visibleColumns: Set<RadarColumnId>;
  onVisibleColumnsChange: (cols: Set<RadarColumnId>) => void;
  emojiRules: readonly RadarMultipleEmojiRule[];
  onEmojiRulesChange: (next: RadarMultipleEmojiRule[]) => void;
  /** Tokens only muted callers have posted; the toggle shows when > 0. */
  mutedOnlyCount: number;
  /** Whether the muted-only toggle is offered at all (Settings › show muted). */
  showMuted: boolean;
  revealMuted: boolean;
  onRevealMutedToggle: () => void;
  rowCount: number;
  refreshing: boolean;
  onRefreshAll: () => void;
}

export default function RadarToolbar({
  windowFilter,
  onWindowFilterChange,
  mentionWindow,
  onMentionWindowChange,
  visibleColumns,
  onVisibleColumnsChange,
  emojiRules,
  onEmojiRulesChange,
  mutedOnlyCount,
  showMuted,
  revealMuted,
  onRevealMutedToggle,
  rowCount,
  refreshing,
  onRefreshAll,
}: RadarToolbarProps) {
  return (
    <div className="oct-headerbar shrink-0 flex items-center gap-cozy px-roomy py-cozy">
      <span className="oct-eyebrow">view: tokens</span>
      <div className="flex gap-tight">
        {WINDOW_FILTERS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => onWindowFilterChange(w)}
            className={cn(
              RADAR_PILL_CLASS,
              'normal-case',
              windowFilter === w ? RADAR_PILL_ON_CLASS : RADAR_PILL_OFF_CLASS,
            )}
          >
            {w}
          </button>
        ))}
      </div>
      <RadarSettings
        mentionWindow={mentionWindow}
        onMentionWindowChange={onMentionWindowChange}
        visibleColumns={visibleColumns}
        onVisibleColumnsChange={onVisibleColumnsChange}
        emojiRules={emojiRules}
        onEmojiRulesChange={onEmojiRulesChange}
      />
      <div className="flex-1" />
      {showMuted && mutedOnlyCount > 0 && (
        <button
          type="button"
          onClick={onRevealMutedToggle}
          className={cn(
            RADAR_PILL_CLASS,
            'flex items-center gap-snug',
            revealMuted ? RADAR_PILL_ON_CLASS : RADAR_PILL_OUTLINE_CLASS,
          )}
          title="Tokens only muted callers have posted"
        >
          {revealMuted ? <Eye size={12} /> : <EyeOff size={12} />}
          {mutedOnlyCount} muted
        </button>
      )}
      <span className="type-data text-oct-muted">
        {rowCount} tokens
      </span>
      <button
        type="button"
        onClick={onRefreshAll}
        disabled={refreshing}
        className="oct-icon-btn px-cozy py-snug font-mono text-2xs font-bold uppercase"
      >
        <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
        refresh
      </button>
    </div>
  );
}
