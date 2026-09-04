// The Contract Feed body: the grouped rows (table view) or cards (grid view).
// Lifted verbatim out of ContractDashboard.tsx.
//
// PERF CONTRACT: `ContractRow`/`ContractCard` are React.memo'd, and their keys
// (`group-<address>-<head messageId>`, `<messageId>-<address>` for history)
// are what keep a row mounted across the constant same-address rescans. Every
// callback below is passed straight through from the dashboard, where it is
// identity-stable. Rows are a live stream and are never animated.
import { Fragment } from 'react';
import type { ContractEntry } from '../../types';
import type { CallerQuality } from '../../hooks/useCallerQuality';
import type { ContractScanGroup } from '../../utils/contractFeedGrouping';
import type { FirstCallerResolution } from '../../utils/firstCaller';
import { groupHistoryOldestFirst, groupSummaryItem } from '../../utils/contractFeedView';
import { ContractRow, ContractCard } from './ContractFeedRows';
import type { ContractViewMode } from './ContractFeedToolbar';

export type ContractFeedGroup = ContractScanGroup<{ entry: ContractEntry; quality: CallerQuality }>;

export interface ContractFeedListProps {
  viewMode: ContractViewMode;
  groups: ContractFeedGroup[];
  firstCallerIndex: Map<string, FirstCallerResolution>;
  /** Lowercased group addresses whose scan history is unfolded (table view only). */
  expandedGroups: Set<string>;
  evmColor: string;
  solColor: string;
  showFull: boolean;
  copiedAddr: string | null;
  /** Good-callers filter is on: unrated rows get a marker. */
  markUnrated: boolean;
  hideBadges: boolean;
  /** Top Callers Feed: per-row caller analytics readout. */
  showStats: boolean;
  timeTick: number;
  onCopy: (addr: string) => void;
  onOpen: (addr: string, evmChain?: string) => void;
  onOpenDiscord: (entry: ContractEntry) => void;
  onDelete: (entry: ContractEntry) => void;
  onShowHolders: (entry: ContractEntry) => void;
  onToggleExpand: (address: string) => void;
}

export default function ContractFeedList({
  viewMode,
  groups,
  firstCallerIndex,
  expandedGroups,
  evmColor,
  solColor,
  showFull,
  copiedAddr,
  markUnrated,
  hideBadges,
  showStats,
  timeTick,
  onCopy,
  onOpen,
  onOpenDiscord,
  onDelete,
  onShowHolders,
  onToggleExpand,
}: ContractFeedListProps) {
  if (viewMode === 'table') {
    return (
      <div className="divide-y divide-oct-border/50">
        {groups.map((group) => {
          // The group's newest scan — what a collapsed row summarises.
          // Derived rather than taken as items[0] so the summary timestamp
          // is the newest scan under any sort mode.
          const head = groupSummaryItem(group);
          const scanCount = group.items.length;
          const isExpanded = scanCount > 1 && expandedGroups.has(group.address);
          // Chronological (oldest-first) history of everything folded into
          // this group, excluding the head row already shown above it.
          const history = scanCount > 1 ? groupHistoryOldestFirst(group) : [];
          return (
            <Fragment key={`group-${group.address}-${head.entry.messageId}`}>
              <ContractRow
                entry={head.entry}
                quality={head.quality}
                evmColor={evmColor}
                solColor={solColor}
                showFull={showFull}
                isCopied={copiedAddr === head.entry.address}
                onCopy={onCopy}
                onOpen={onOpen}
                onOpenDiscord={onOpenDiscord}
                onDelete={onDelete}
                onShowHolders={onShowHolders}
                forceIsNew={group.hasNew}
                scanCount={scanCount}
                isExpanded={isExpanded}
                onToggleExpand={scanCount > 1 ? onToggleExpand : undefined}
                firstCall={firstCallerIndex.get(group.address)}
                markUnrated={markUnrated}
                hideBandBadge={hideBadges}
                showStats={showStats}
                timeTick={timeTick}
              />
              {isExpanded && (
                <div className="pl-comfy sm:pl-section border-l-2 border-oct-border/60 ml-comfy sm:ml-section">
                  {history.map(({ entry, quality }) => (
                    <ContractRow
                      key={`${entry.messageId}-${entry.address}`}
                      entry={entry}
                      quality={quality}
                      evmColor={evmColor}
                      solColor={solColor}
                      showFull={showFull}
                      isCopied={copiedAddr === entry.address}
                      onCopy={onCopy}
                      onOpen={onOpen}
                      onOpenDiscord={onOpenDiscord}
                      onDelete={onDelete}
                      onShowHolders={onShowHolders}
                      firstCall={firstCallerIndex.get(group.address)}
                      markUnrated={markUnrated}
                      hideBandBadge={hideBadges}
                      isSubRow
                      timeTick={timeTick}
                    />
                  ))}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-cozy sm:gap-comfy p-comfy sm:p-roomy">
      {groups.map((group) => {
        const head = groupSummaryItem(group);
        const scanCount = group.items.length;
        return (
          <ContractCard
            key={`group-${group.address}-${head.entry.messageId}`}
            entry={head.entry}
            quality={head.quality}
            evmColor={evmColor}
            solColor={solColor}
            isCopied={copiedAddr === head.entry.address}
            onCopy={onCopy}
            onOpen={onOpen}
            onOpenDiscord={onOpenDiscord}
            onDelete={onDelete}
            onShowHolders={onShowHolders}
            forceIsNew={group.hasNew}
            scanCount={scanCount}
            firstCall={firstCallerIndex.get(group.address)}
            markUnrated={markUnrated}
            hideBandBadge={hideBadges}
            showStats={showStats}
            timeTick={timeTick}
          />
        );
      })}
    </div>
  );
}
