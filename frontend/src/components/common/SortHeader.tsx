import { ChevronUp, ChevronDown } from 'lucide-react';
import type { SortDir } from '../../lib/sort';

// The shared click-to-sort header, extracted from RadarTable so the Radar and the
// pump.fun tables render an identical control: an uppercase label with a stacked
// up/down chevron pair, the active column tinted accent with its live direction lit.
//
// Two exports because not every sortable surface is a <table>: `SortButton` is the
// bare control (used directly in the leaderboard's list header, which has no <th>),
// and `SortHeader` wraps it in a <th> for real table heads. Generic over the key so
// each table keeps its own strongly-typed SortKey union.

interface SortControlProps<K extends string> {
  label: string;
  /** The column this header sorts by. */
  sortKey: K;
  /** The column currently active, to decide whether this header is lit. */
  activeKey: K;
  dir: SortDir;
  onSort: (key: K) => void;
  align?: 'left' | 'right';
  /** Hover text for the column. Used where the label alone (e.g. a bare ×)
   *  doesn't say what the number actually measures. */
  title?: string;
}

/** The bare sort control (label + chevrons). Use inside a <th> via SortHeader, or on
 *  its own in a non-table header row. */
export function SortButton<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
  title,
}: SortControlProps<K>) {
  const active = activeKey === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      title={title}
      className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors ${
        align === 'right' ? 'flex-row-reverse ml-auto' : ''
      } ${active ? 'text-oct-accent' : 'text-oct-muted hover:text-oct-text'}`}
    >
      <span>{label}</span>
      <span className={`inline-flex flex-col -space-y-1 shrink-0 ${active ? 'text-oct-accent' : 'text-oct-muted/60'}`}>
        <ChevronUp
          size={10}
          strokeWidth={2.5}
          className={active && dir === 'asc' ? 'opacity-100' : 'opacity-35'}
        />
        <ChevronDown
          size={10}
          strokeWidth={2.5}
          className={active && dir === 'desc' ? 'opacity-100' : 'opacity-35'}
        />
      </span>
    </button>
  );
}

/** A sortable table-head cell: SortButton wrapped in the shared <th> chrome. */
export function SortHeader<K extends string>(props: SortControlProps<K>) {
  const { align = 'left' } = props;
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <SortButton {...props} />
    </th>
  );
}
