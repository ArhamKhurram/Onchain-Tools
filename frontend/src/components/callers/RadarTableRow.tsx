// One radar row, memoized. The table re-renders on every liveMc tick, copy
// click, spinner toggle and store change; with ~600 rows on a busy feed the
// per-commit reconciliation of untouched rows dominated the profile. memo()
// lets a commit skip every row whose inputs didn't change — props are either
// primitives or references that RadarTable keeps stable across such commits.
import { memo } from 'react';
import { RefreshCw, Copy, Check, Users } from 'lucide-react';
import SignalConvergenceBadge from '../SignalConvergenceBadge';
import {
  BAND_DOT_CLASS,
  BAND_TEXT_CLASS,
  BAND_TITLE,
  BAND_BADGE_CLASS,
  BAND_NAME_COLOR,
  bandIsNotable,
} from '../../utils/callerBandStyle';
import { BAND_LABELS, radarEmojiForMultiple, type RadarMultipleEmojiRule } from '@oct/shared';
import type { FomoTrade, FomoHolderOverlap } from '../../types/fomo';
import type { NetworkFirstScan } from '../../hooks/useNetworkFirstScans';
import type { RadarColumnId } from './radarColumns';
import type { MentionWindow } from './RadarSettings';
import {
  countWithin,
  formatCompact,
  pickGlobalFirst,
  timeAgoShort,
  MENTION_WINDOW_MS,
  type LiveMc,
  type RadarRow,
} from './radarRows';

const CHAIN_LABELS: Record<string, string> = {
  eth: 'ETH', bsc: 'BNB', base: 'BASE', arb: 'ARB', blast: 'BLAST',
  polygon: 'POLY', avax: 'AVAX', linea: 'LINEA', sonic: 'SONIC',
  hyperliquid: 'HL', robinhood: 'HOOD',
};

const CHAIN_DOTS: Record<string, string> = {
  robinhood: '#22C55E',
  base: '#2B4EFF',
  eth: '#627EEA',
  bsc: '#F0B90B',
  arb: '#28A0F0',
};

function platformMeta(chain: 'evm' | 'sol', evmChain?: string): { label: string; dot: string } {
  if (chain === 'sol') return { label: 'SOL', dot: '#9945FF' };
  const label = evmChain ? (CHAIN_LABELS[evmChain] ?? evmChain.toUpperCase()) : 'EVM';
  const dot = (evmChain && CHAIN_DOTS[evmChain]) ?? '#2B4EFF';
  return { label, dot };
}

const GLOBAL_FIRST_TITLE =
  "Earliest known call/scan: from Rick's cross-server data or the anonymous OCT network pool. Never reveals which group or user saw it.";

// The × column is live MC ÷ MC at the first call. Two things it is NOT, both of
// which the emoji markers make it tempting to read as: it is not a realised
// return (nobody bought at MC@call and sold now), and it is not a peak — it
// tracks the live quote and falls back down when the token does. MC@call itself
// is the earliest FDV captured near the first mention, so the ratio is an
// approximation on both ends. Settings › Caller Quality carries the matching
// caveat for the peak-based caller multiples ("floors, not exact ATHs"); this
// one is a different number and gets its own wording.
export const MULT_TITLE =
  'Live market cap ÷ market cap at the first call. A live, unrealised quote that falls as well as rises — not profit, and not a peak. MC@call is the earliest FDV captured near that first mention, so treat the ratio as approximate. Emoji markers just flag the level the × has reached; configure them under columns.';

export interface RadarTableRowProps {
  r: RadarRow;
  live?: LiveMc;
  overlap?: FomoHolderOverlap;
  netScan?: NetworkFirstScan;
  convergenceTrade: FomoTrade | null;
  convergenceWindowMinutes: number;
  activeColumns: RadarColumnId[];
  mentionWindow: MentionWindow;
  emojiRules: RadarMultipleEmojiRule[];
  isCopied: boolean;
  isRefreshing: boolean;
  /**
   * Bumped once a minute by the table so relative "ago" text stays fresh on
   * rows whose data hasn't otherwise changed. Not read — a memo-buster only.
   */
  agoTick: number;
  onCopy: (address: string) => void;
  onRefresh: (address: string, evmChain?: string) => void;
}

const RadarTableRow = memo(function RadarTableRow({
  r,
  live,
  overlap,
  netScan,
  convergenceTrade,
  convergenceWindowMinutes,
  activeColumns,
  mentionWindow,
  emojiRules,
  isCopied,
  isRefreshing,
  onCopy,
  onRefresh,
}: RadarTableRowProps) {
  const mcNow = live?.mc;
  const mcNowDisplay = live?.display;
  const mult = r.mcAtCall && mcNow && r.mcAtCall > 0 ? mcNow / r.mcAtCall : undefined;
  const tag = r.mentions >= 5 ? 'crowded' : r.mentions === 1 ? 'early' : null;
  const plat = platformMeta(r.chain, r.evmChain);
  const shortAddr = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
  const ticker = r.symbol ? `$${r.symbol}` : shortAddr;
  const subtitle = r.name ?? (r.symbol ? shortAddr : null);
  const fomoHold = overlap?.trackedCount ?? 0;

  return (
    <tr className="border-b border-oct-border/50 oct-row-hover">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2 min-w-0 max-w-[260px]">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/20"
            style={{ backgroundColor: plat.dot }}
            title={plat.label}
            aria-label={plat.label}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="font-mono text-sm font-semibold text-oct-text truncate"
                title={r.symbol ?? r.address}
              >
                {ticker}
              </span>
              {tag === 'crowded' && (
                <span className="shrink-0 text-[10px] font-mono font-semibold uppercase px-1.5 py-0.5 rounded-full bg-oct-accent/15 text-oct-accent">
                  crowded
                </span>
              )}
              {tag === 'early' && (
                <span className="shrink-0 text-[10px] font-mono font-semibold uppercase px-1.5 py-0.5 rounded-full bg-oct-green/15 text-oct-green">
                  early
                </span>
              )}
              {convergenceTrade && (
                <SignalConvergenceBadge
                  trade={convergenceTrade}
                  windowMinutes={convergenceWindowMinutes}
                />
              )}
            </div>
            {subtitle && (
              <div className="text-xs text-oct-muted truncate">{subtitle}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onCopy(r.address)}
            className="shrink-0 p-1 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors"
            title="Copy address"
          >
            {isCopied ? <Check size={13} className="text-oct-green" /> : <Copy size={13} />}
          </button>
        </div>
      </td>
      {activeColumns.map((col) => {
        switch (col) {
          case 'mentions':
            return (
              <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                {r.mentions}
              </td>
            );
          case 'callers':
            return (
              <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                {r.callers.size}
              </td>
            );
          case 'fomo':
            return (
              <td key={col} className="px-3 py-2 text-right">
                {fomoHold > 0 ? (
                  <span
                    className="inline-flex items-center gap-1 font-mono text-xs font-bold text-oct-accent"
                    title={overlap?.trackedHandles?.map((h) => `@${h}`).join(', ') ?? ''}
                  >
                    <Users size={12} />
                    {fomoHold}
                  </span>
                ) : (
                  <span className="text-oct-muted">·</span>
                )}
              </td>
            );
          case 'groups':
            return (
              <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                {r.groups.size}
              </td>
            );
          case 'windowMentions':
            return (
              <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                {countWithin(r.timestamps, MENTION_WINDOW_MS[mentionWindow]) || '·'}
              </td>
            );
          case 'recent':
            return (
              <td key={col} className="px-3 py-2 text-right font-mono text-xs text-oct-muted tabular-nums whitespace-nowrap">
                {timeAgoShort(r.lastMentionAt)}
              </td>
            );
          case 'firstCaller':
            return (
              <td key={col} className="px-3 py-2 text-sm truncate max-w-[160px]">
                {/* Same band colour + badge as the feed (Message.tsx). A name
                    is worth very different amounts depending on who it is, and
                    the radar was the one place that withheld that. */}
                {r.firstCallerBand && bandIsNotable(r.firstCallerBand) && (
                  <span
                    className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full mr-1 align-middle ${BAND_BADGE_CLASS[r.firstCallerBand]}`}
                    title={BAND_TITLE[r.firstCallerBand]}
                  >
                    {BAND_LABELS[r.firstCallerBand]}
                  </span>
                )}
                <span
                  style={{ color: r.firstCallerBand ? BAND_NAME_COLOR[r.firstCallerBand] ?? undefined : undefined }}
                  className={r.firstCallerBand && BAND_NAME_COLOR[r.firstCallerBand] ? '' : 'text-oct-muted'}
                >
                  {r.firstCaller}
                </span>
              </td>
            );
          case 'mcAtCall':
            return (
              <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-muted tabular-nums">
                {r.mcAtCallDisplay ?? '—'}
              </td>
            );
          case 'globalFirst': {
            const gf = pickGlobalFirst(r, netScan);
            return (
              <td
                key={col}
                className="px-3 py-2 font-mono text-xs whitespace-nowrap max-w-[200px] truncate"
                title={GLOBAL_FIRST_TITLE}
              >
                {gf ? (
                  <>
                    <span className={gf.label === 'network' ? 'text-oct-muted' : 'text-oct-text'}>
                      {gf.label}
                    </span>
                    {gf.mcapUsd != null && gf.mcapUsd > 0 && (
                      <span className="text-oct-muted"> @ {formatCompact(gf.mcapUsd)}</span>
                    )}
                    {gf.atMs != null && (
                      <span className="text-oct-muted tabular-nums"> · {timeAgoShort(gf.atMs)}</span>
                    )}
                  </>
                ) : (
                  <span className="text-oct-muted">—</span>
                )}
              </td>
            );
          }
          case 'mcNow':
            return (
              <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-live tabular-nums whitespace-nowrap">
                {mcNowDisplay ?? '—'}
                {live && (
                  <span className="ml-1 text-[10px] text-oct-muted">{timeAgoShort(live.at)}</span>
                )}
              </td>
            );
          case 'mult': {
            // One marker only: `radarEmojiForMultiple` returns the
            // highest matching rung, never the set of rungs passed.
            // Fixed-width and outside the tabular-nums span so a
            // wide glyph can't push the digits out of column.
            const emoji = radarEmojiForMultiple(mult, emojiRules);
            return (
              <td key={col} className="px-3 py-2 text-right font-mono text-sm" title={MULT_TITLE}>
                <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
                  <span className="w-4 text-center leading-none" aria-hidden={!emoji}>
                    {emoji ?? ''}
                  </span>
                  {mult != null ? (
                    <span className={`tabular-nums ${mult >= 1 ? 'text-oct-green' : 'text-oct-accent'}`}>
                      {mult.toFixed(1)}x
                    </span>
                  ) : (
                    <span className="text-oct-muted">—</span>
                  )}
                </span>
              </td>
            );
          }
          case 'quality':
            return (
              <td key={col} className="px-3 py-2 text-right whitespace-nowrap">
                {r.bestBand && r.bestBand !== 'unrated' ? (
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-bold uppercase ${BAND_TEXT_CLASS[r.bestBand]}`}
                    title={BAND_TITLE[r.bestBand]}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${BAND_DOT_CLASS[r.bestBand]}`} />
                    {BAND_LABELS[r.bestBand]}
                  </span>
                ) : (
                  <span className="text-oct-muted text-[11px]">—</span>
                )}
              </td>
            );
          default:
            return null;
        }
      })}
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={() => onRefresh(r.address, r.evmChain)}
          disabled={isRefreshing}
          className="p-1 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors"
          title="Refresh market cap"
        >
          <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
        </button>
      </td>
    </tr>
  );
});

export default RadarTableRow;
