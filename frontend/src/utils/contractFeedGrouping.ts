import type { ContractEntry } from '../types';

// The feed re-broadcasts the same contract every time it's rescanned
// (scheduleDexFallback on the backend, see CLAUDE.md's core data flow), so a
// single hot token can flood the Contract Feed with a dozen near-identical
// full-height rows and bury genuinely new detections underneath. This module
// groups consecutive-in-time rows that share the same contract ADDRESS
// (never symbol — tickers collide across unrelated tokens) so the UI can
// render one collapsed row per burst instead of one row per scan.
//
// Grouping window: two scans of the same address only join the same group if
// they land within CONTRACT_RESCAN_GROUP_WINDOW_MS of each other (compared
// scan-to-scan, not first-to-last, so a long-running hot token doesn't chain
// into one unbounded group). 20 minutes comfortably covers the rescan bursts
// that motivated this change (the reported case had 7 rescans spanning ~9
// minutes) while still splitting an address that goes quiet and then gets
// rescanned hours later into a separate, fresh group.
export const CONTRACT_RESCAN_GROUP_WINDOW_MS = 20 * 60 * 1000;

export interface ContractFeedItem {
  entry: ContractEntry;
}

export interface ContractScanGroup<T extends ContractFeedItem> {
  /** Lowercased contract address this group represents. */
  address: string;
  /**
   * Every item in the group, newest-first — the same order the feed itself
   * uses. `items[0]` is the latest scan and is what a collapsed row's
   * summary (symbol, FDV/Liq, timestamp) should be built from.
   */
  items: T[];
  /**
   * True if any scan in the group was the address's very first detection
   * (`firstSeen !== false`). A group that started NEW and then got
   * rescanned should keep showing the NEW badge, not flip to RESCAN, even
   * though the group's head item is itself a rescan.
   */
  hasNew: boolean;
}

/**
 * Groups feed items by contract address, preserving the input order and
 * only merging occurrences of the same address that fall within
 * `windowMs` of the group's most recently added item.
 *
 * `items` is expected newest-first (the order `contractsSlice` stores the
 * feed in). A group with a single item behaves identically to the
 * ungrouped row that used to render for it — callers can treat
 * `items.length === 1` as "render as before".
 */
export function groupContractFeedByAddress<T extends ContractFeedItem>(
  items: readonly T[],
  windowMs: number = CONTRACT_RESCAN_GROUP_WINDOW_MS,
): ContractScanGroup<T>[] {
  const groups: ContractScanGroup<T>[] = [];
  // Tracks the most recent group created/extended for each address — plus the
  // already-parsed timestamp of its last appended item, so each item's
  // timestamp is Date-parsed exactly once instead of once as itself and again
  // as the next same-address item's "last" — so a same-address item later in
  // the list can find and extend it, even if other addresses' rows are
  // interleaved in between.
  const currentGroupByAddress = new Map<string, { group: ContractScanGroup<T>; lastTs: number }>();

  for (const item of items) {
    const address = item.entry.address.toLowerCase();
    const ts = new Date(item.entry.timestamp).getTime();
    const isNew = item.entry.firstSeen !== false;

    const current = currentGroupByAddress.get(address);
    if (current) {
      const withinWindow = Number.isFinite(ts) && Number.isFinite(current.lastTs)
        ? Math.abs(current.lastTs - ts) <= windowMs
        : false;
      if (withinWindow) {
        current.group.items.push(item);
        current.lastTs = ts;
        if (isNew) current.group.hasNew = true;
        continue;
      }
    }

    const group: ContractScanGroup<T> = { address, items: [item], hasNew: isNew };
    groups.push(group);
    currentGroupByAddress.set(address, { group, lastTs: ts });
  }

  return groups;
}
