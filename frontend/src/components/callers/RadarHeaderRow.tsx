// The Radar's <thead> row: one SortHeader per visible column. Kept as a
// sibling of RadarTableRow so the table file itself is composition only.
import { SortHeader } from '../common/SortHeader';
import type { SortDir } from '../../lib/sort';
import type { MentionWindow } from './RadarSettings';
import { RADAR_COLUMN_LABELS, type RadarColumnId } from './radarColumns';
import type { RadarSortKey } from './radarSort';
import { MULT_TITLE } from './RadarTableRow';

export interface RadarHeaderRowProps {
  activeColumns: RadarColumnId[];
  mentionWindow: MentionWindow;
  sortKey: RadarSortKey;
  sortDir: SortDir;
  onSort: (key: RadarSortKey) => void;
}

export default function RadarHeaderRow({
  activeColumns,
  mentionWindow,
  sortKey,
  sortDir,
  onSort,
}: RadarHeaderRowProps) {
  return (
    // `type-caption` (12px) is the column-label role; `font-bold` and the
    // wide tracking sit on top of it as utilities. Was `text-[11px]`.
    <tr className="font-mono type-caption font-bold uppercase tracking-[0.1em] text-oct-muted">
      <SortHeader<RadarSortKey> label="Token" sortKey="token" activeKey={sortKey} dir={sortDir} onSort={onSort} />
      {activeColumns.map((col) => (
        <SortHeader<RadarSortKey>
          key={col}
          // The window column is labelled by its live window ("15m"), not a
          // fixed name, so the header re-labels when the setting changes.
          label={col === 'windowMentions' ? mentionWindow : RADAR_COLUMN_LABELS[col]}
          sortKey={col}
          activeKey={sortKey}
          dir={sortDir}
          onSort={onSort}
          align={col === 'firstCaller' || col === 'globalFirst' ? 'left' : 'right'}
          title={col === 'mult' ? MULT_TITLE : undefined}
        />
      ))}
      {/* Matches SortHeader's own <th> padding (shared with the pump tables). */}
      <th className="px-3 py-2 font-medium w-8" />
    </tr>
  );
}
