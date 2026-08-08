import { useCallback, useState } from 'react';
import type { SortDir } from '../lib/sort';

// The click-to-sort state machine, lifted verbatim from RadarTable's handleSort so
// every sortable table toggles the same way: click a new column → sort by it in its
// natural first direction; click the active column again → flip the direction. Kept
// as a hook (not inline) so the Radar and the pump tables share one behaviour rather
// than three copies that drift.

export interface SortState<K extends string> {
  sortKey: K;
  sortDir: SortDir;
  /** Click handler for a header: switch column, or flip direction if already active. */
  onSort: (key: K) => void;
}

/**
 * @param defaultKey   the column sorted on first paint
 * @param defaultDir   its initial direction
 * @param ascFirstKeys columns that should open ascending (text columns usually read
 *   better A→Z; numeric columns open descending so the biggest is on top). MUST be a
 *   stable reference — pass a module-level constant, not an inline array, or the
 *   memoised handler rebuilds every render.
 */
export function useSort<K extends string>(
  defaultKey: K,
  defaultDir: SortDir = 'desc',
  ascFirstKeys: readonly K[] = [],
): SortState<K> {
  const [sortKey, setSortKey] = useState<K>(defaultKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);

  const onSort = useCallback(
    (key: K) => {
      if (key === sortKey) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir(ascFirstKeys.includes(key) ? 'asc' : 'desc');
      }
    },
    [sortKey, ascFirstKeys],
  );

  return { sortKey, sortDir, onSort };
}
