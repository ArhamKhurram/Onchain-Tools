import type { ContractEntry } from '../types';
import { canOpenContractSource } from './contractSource';

/**
 * "Take me to whoever called this CA first."
 *
 * What "first" can honestly mean here matters more than the plumbing:
 *
 * - The console only knows the rows in its own contract log. `firstSeen` is set
 *   by the backend at log time (`!hasAddress(address)` in
 *   `backend/src/utils/contractLog.ts`), so a row carrying `firstSeen === true`
 *   is the first time *this install* ever saw the address. That is a real
 *   claim, and only then does the UI say "first caller".
 * - Otherwise the earliest row we hold is just the earliest row we hold — the
 *   feed is capped at 2000 and the log is windowed, so the actual first call
 *   may predate both. Those cases are labelled "earliest in view" rather than
 *   overclaiming.
 * - Rick's embed sometimes reports a *global* first caller
 *   (`entry.firstCallerName`) from servers we don't even watch. There is no
 *   message to open for it, so it is surfaced as text and never as a
 *   destination.
 *
 * Links, not rows: a Telegram row in a plain group or DM produces no `t.me`
 * URL (see `canOpenContractSource`), so the resolver falls back to the earliest
 * row it can actually open and reports that it did.
 */
export interface FirstCallerResolution {
  /** The row a "jump to first caller" action should open. Always linkable. */
  entry: ContractEntry;
  /** The earliest row we hold for the address, linkable or not. */
  earliest: ContractEntry;
  /** True when `entry` is the address's first-ever detection in this log. */
  isFirstLogged: boolean;
  /** True when an earlier row exists but can't produce a URL, so it was skipped. */
  skippedUnlinkable: boolean;
}

function timeOf(entry: ContractEntry): number {
  const ms = new Date(entry.timestamp).getTime();
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

/**
 * One pass over the loaded contract log, so a feed of hundreds of rows doesn't
 * re-scan it per row. Keyed by lowercased address; addresses with nothing
 * linkable are omitted, because there is no action to offer for them.
 */
export function buildFirstCallerIndex(
  contracts: readonly ContractEntry[],
): Map<string, FirstCallerResolution> {
  interface Acc {
    earliest: ContractEntry;
    earliestLinkable?: ContractEntry;
  }
  const acc = new Map<string, Acc>();

  for (const entry of contracts) {
    const address = entry.address.toLowerCase();
    const linkable = canOpenContractSource(entry);
    const existing = acc.get(address);

    if (!existing) {
      acc.set(address, { earliest: entry, earliestLinkable: linkable ? entry : undefined });
      continue;
    }
    if (timeOf(entry) < timeOf(existing.earliest)) existing.earliest = entry;
    if (linkable && (!existing.earliestLinkable || timeOf(entry) < timeOf(existing.earliestLinkable))) {
      existing.earliestLinkable = entry;
    }
  }

  const index = new Map<string, FirstCallerResolution>();
  for (const [address, { earliest, earliestLinkable }] of acc) {
    if (!earliestLinkable) continue;
    index.set(address, {
      entry: earliestLinkable,
      earliest,
      isFirstLogged: earliestLinkable === earliest && earliest.firstSeen === true,
      skippedUnlinkable: earliestLinkable !== earliest,
    });
  }

  return index;
}

/**
 * Should a row offer a "jump to the first caller" action? Only when it would
 * land somewhere other than the row itself.
 */
export function firstCallerIsElsewhere(
  resolution: FirstCallerResolution | undefined,
  entry: ContractEntry,
): resolution is FirstCallerResolution {
  return resolution != null && resolution.entry.messageId !== entry.messageId;
}
