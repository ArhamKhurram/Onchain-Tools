import { Search, LayoutGrid, List, Eye, EyeOff, BadgeCheck, Clock, ArrowDownWideNarrow, Info } from 'lucide-react';
import { BAND_REACH_NOTE } from '../../utils/callerBandStyle';
import type { ContractSortMode } from '../../utils/contractFeedView';

export type ContractViewMode = 'table' | 'cards';
export type ContractChainFilter = 'all' | 'evm' | 'sol';

interface ContractFeedToolbarProps {
  viewMode: ContractViewMode;
  onViewMode: (mode: ContractViewMode) => void;
  chainFilter: ContractChainFilter;
  onChainFilter: (filter: ContractChainFilter) => void;
  search: string;
  onSearch: (value: string) => void;
  sortMode: ContractSortMode;
  onSortMode: (mode: ContractSortMode) => void;
  /** True when Ranked is the mode because Settings asked for it, not the toolbar. */
  sortFromSettings: boolean;
  goodOnly: boolean;
  onGoodOnly: (value: boolean) => void;
  /** Rows the filter kept but couldn't vouch for. */
  unratedShown: number;
  /** Rows the filter cut (mixed, slop, muted). */
  goodHidden: number;
  showMuted: boolean;
  mutedCount: number;
  revealMuted: boolean;
  onRevealMuted: (value: boolean) => void;
  /**
   * Top Callers Feed mode. The pane is already locked to elite + trusted
   * callers, so the "Hide slop" and "muted" controls are meaningless here and
   * are dropped — showing them would imply the feed could contain slop or muted
   * rows, which it can't.
   */
  topOnly?: boolean;
}

const SEGMENT_GROUP = 'flex rounded-oct-sm overflow-hidden border border-oct-border text-xs shrink-0';

function segmentClass(active: boolean): string {
  return `px-2.5 py-1 font-mono font-bold uppercase transition-colors flex items-center gap-1 ${
    active ? 'bg-oct-accent text-white' : 'bg-oct-surface text-oct-muted hover:text-oct-text'
  }`;
}

function chipClass(active: boolean): string {
  return `flex items-center gap-1 px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold uppercase border transition-all shrink-0 ${
    active
      ? 'border-oct-accent/50 bg-oct-accent text-white shadow-oct-glow-accent'
      : 'border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'
  }`;
}

/**
 * The Contract Feed's controls.
 *
 * Two of these exist because the feed was quietly doing something the UI never
 * admitted to: caller ranking reorders rows so an older call can sit above a
 * newer one (which reads as a broken feed), and the good-callers filter keeps
 * unrated callers, which has to be stated rather than assumed.
 */
export default function ContractFeedToolbar({
  viewMode,
  onViewMode,
  chainFilter,
  onChainFilter,
  search,
  onSearch,
  sortMode,
  onSortMode,
  sortFromSettings,
  goodOnly,
  onGoodOnly,
  unratedShown,
  goodHidden,
  showMuted,
  mutedCount,
  revealMuted,
  onRevealMuted,
  topOnly = false,
}: ContractFeedToolbarProps) {
  const ranked = sortMode === 'ranked';

  return (
    <>
      <div className="flex items-center gap-2 px-3 sm:px-4 pb-3 overflow-x-auto scrollbar-none">
        <div className={SEGMENT_GROUP}>
          <button
            onClick={() => onViewMode('table')}
            className={`px-2 py-1 transition-colors ${
              viewMode === 'table'
                ? 'bg-oct-accent text-white'
                : 'bg-oct-surface text-oct-muted hover:text-oct-text'
            }`}
            title="Table view"
          >
            <List size={14} />
          </button>
          <button
            onClick={() => onViewMode('cards')}
            className={`px-2 py-1 transition-colors ${
              viewMode === 'cards'
                ? 'bg-oct-accent text-white'
                : 'bg-oct-surface text-oct-muted hover:text-oct-text'
            }`}
            title="Card view"
          >
            <LayoutGrid size={14} />
          </button>
        </div>

        <div className={SEGMENT_GROUP}>
          {(['all', 'evm', 'sol'] as const).map((f) => (
            <button
              key={f}
              onClick={() => onChainFilter(f)}
              className={`px-2.5 py-1 font-mono font-bold uppercase transition-colors ${
                chainFilter === f
                  ? 'bg-oct-accent text-white'
                  : 'bg-oct-surface text-oct-muted hover:text-oct-text'
              }`}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Sort mode. Always visible, because "why is that old call at the top"
            has no answer while the mode is invisible. */}
        <div className={SEGMENT_GROUP}>
          <button
            onClick={() => onSortMode('recent')}
            className={segmentClass(!ranked)}
            title="Newest scan first"
          >
            <Clock size={12} />
            <span>Recent</span>
          </button>
          <button
            onClick={() => onSortMode('ranked')}
            className={segmentClass(ranked)}
            title="Caller quality first, newest second — a trusted caller's older call will sit above a fresh detection"
          >
            <ArrowDownWideNarrow size={12} />
            <span>Ranked</span>
          </button>
        </div>

        {!topOnly && (
          <button
            onClick={() => onGoodOnly(!goodOnly)}
            className={chipClass(goodOnly)}
            title={
              goodOnly
                ? 'Show every caller again'
                : 'Hide Mixed, Slop and muted callers. Keeps Solid, Elite, Trusted — and new callers not rated yet, so early runners still get through.'
            }
          >
            <BadgeCheck size={12} />
            {/* "Hide slop", not "Good callers": the filter keeps not-yet-rated
                callers (MIN_RATED_CALLS = 10 means every new caller is unrated),
                so a label promising only proven callers would overstate what it
                does. Naming it for what it removes is exactly true. */}
            <span>Hide slop</span>
          </button>
        )}

        <div className="relative flex-1 min-w-[120px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-oct-muted" />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            className="oct-input pl-8 pr-3 py-1.5 text-sm w-full"
          />
        </div>

        {!topOnly && showMuted && mutedCount > 0 && (
          <button
            onClick={() => onRevealMuted(!revealMuted)}
            className={chipClass(revealMuted)}
            title={revealMuted ? 'Hide muted callers again' : 'Show contracts from muted callers'}
          >
            {revealMuted ? <Eye size={12} /> : <EyeOff size={12} />}
            <span>{mutedCount} muted</span>
          </button>
        )}
      </div>

      {(ranked || goodOnly) && (
        <div className="flex items-start gap-1.5 px-3 sm:px-4 pb-2.5 -mt-1 text-[11px] leading-snug text-oct-muted">
          <Info size={12} className="shrink-0 mt-[1px]" />
          <p className="min-w-0">
            {ranked && (
              <span>
                <span className="font-bold text-oct-text">Sorted by caller quality, not time</span>
                {' '}— a trusted or high-band caller&rsquo;s older call sits above a fresher
                detection.
                {sortFromSettings ? ' (Default from Settings → Caller Quality.)' : ''}{' '}
              </span>
            )}
            {goodOnly && (
              <span>
                <span className="font-bold text-oct-text">Hiding slop</span>
                {goodHidden > 0 ? ` — ${goodHidden} mixed/slop hidden.` : ' — nothing hidden yet.'}{' '}
                {unratedShown > 0
                  ? `${unratedShown} call${unratedShown === 1 ? '' : 's'} from not-yet-rated callers are kept and tagged UNRATED, so a new sharp caller isn’t buried. `
                  : 'New callers with no rating yet are kept and tagged UNRATED. '}
                {BAND_REACH_NOTE}
              </span>
            )}
          </p>
        </div>
      )}
    </>
  );
}
