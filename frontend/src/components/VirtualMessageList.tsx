import { forwardRef, useEffect, useImperativeHandle, useReducer, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FrontendMessage } from '../types';
import { DEFAULT_FEED_ROW_DENSITY, FEED_ROW_HEIGHT_ESTIMATE } from './feed/feedChromeContract';

// Rows differ wildly (compact one-liners vs embeds/images), so this is only a
// first guess; every mounted row is measured for real via `measureElement`
// and heights are cached per message id. The pane passes a density-specific
// estimate; this is the fallback for panes outside the Feed shell.
const ESTIMATED_ROW_HEIGHT = FEED_ROW_HEIGHT_ESTIMATE[DEFAULT_FEED_ROW_DENSITY];
// Rows kept mounted beyond each edge of the viewport, so quick flicks and the
// jump-flash have real DOM to land on without re-inflating the mount count.
const OVERSCAN = 8;

export interface VirtualMessageListHandle {
  /**
   * Scroll the row for `messageId` into view (centred) and flash it with
   * `flashClasses`. Returns false when the id is not in the current list —
   * e.g. filtered out, past the freeze boundary, or evicted by the room cap.
   */
  scrollToMessage: (messageId: string, flashClasses?: string[]) => boolean;
}

interface VirtualMessageListProps {
  items: FrontendMessage[];
  /** The pane's scroll container (owned by ChatPane, which drives anchoring). */
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  /** Observed by ChatPane to re-stick to the bottom as content height changes. */
  contentRef: React.RefObject<HTMLDivElement | null>;
  renderRow: (msg: FrontendMessage, index: number) => React.ReactNode;
  /**
   * First-guess row height before measurement, in px. Follows the pane's row
   * density so the scrollbar and jump targets don't lurch when a preset packs
   * rows tighter or looser than the default estimate.
   */
  estimatedRowHeight?: number;
}

/**
 * Windowed message list: only the rows near the viewport are mounted, with
 * dynamic per-row measurement so variable-height messages don't jump.
 *
 * Known, accepted trade-offs of unmounting off-screen rows: the browser's own
 * Ctrl+F only finds mounted rows (the pane's built-in search covers the full
 * list), and text selection cannot span beyond the mounted window.
 */
const VirtualMessageList = forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(
  function VirtualMessageList({ items, scrollElementRef, contentRef, renderRow, estimatedRowHeight = ESTIMATED_ROW_HEIGHT }, ref) {
    const virtualizer = useVirtualizer({
      count: items.length,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: () => estimatedRowHeight,
      overscan: OVERSCAN,
      // Cache measured heights by message id, not index, so appends and
      // head-evictions (the per-room cap) don't corrupt row heights.
      getItemKey: (index) => items[index].id,
    });

    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    // The scroll container lives in the PARENT (ChatPane), so its ref is not
    // yet attached when this component's layout effects run on a fresh mount —
    // `getScrollElement` returns null and the virtualizer renders nothing.
    // The virtualizer re-reads the element on every render, so force exactly
    // one post-mount render (passive effects run after all refs attach).
    // Without this, panes (re)mounted after boot — e.g. adding a split pane —
    // stay empty until some unrelated store change re-renders them.
    const [, forceRender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      forceRender();
    }, []);

    // A density change restyles every row at once. Mounted rows re-measure on
    // their own (ResizeObserver), but the cache still holds stale heights for
    // every unmounted row, so drop it and let the new estimate stand in until
    // those rows come back into view. Skipped on mount: the cache is empty.
    const prevEstimateRef = useRef(estimatedRowHeight);
    useEffect(() => {
      if (prevEstimateRef.current === estimatedRowHeight) return;
      prevEstimateRef.current = estimatedRowHeight;
      virtualizer.measure();
    }, [estimatedRowHeight, virtualizer]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToMessage: (messageId, flashClasses = []) => {
          const index = items.findIndex((m) => m.id === messageId);
          if (index === -1) return false;
          virtualizer.scrollToIndex(index, { align: 'center' });
          // The target row may take a couple of frames to mount and measure
          // (estimates refine as rows appear), so settle briefly before
          // flashing. `document` here is the pane's own document — the popout
          // window runs its own app instance.
          let attempts = 0;
          const settle = () => {
            attempts++;
            virtualizer.scrollToIndex(index, { align: 'center' });
            const el = document.getElementById(`msg-${messageId}`);
            if (el && attempts >= 2) {
              if (flashClasses.length > 0) {
                el.classList.add(...flashClasses);
                clearTimeout(flashTimerRef.current);
                flashTimerRef.current = setTimeout(() => {
                  document.getElementById(`msg-${messageId}`)?.classList.remove(...flashClasses);
                }, 2000);
              }
              return;
            }
            if (attempts < 10) requestAnimationFrame(settle);
          };
          requestAnimationFrame(settle);
          return true;
        },
      }),
      [items, virtualizer],
    );

    return (
      <div ref={contentRef} className="pb-[1vh]">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const msg = items[vi.index];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                id={`msg-${msg.id}`}
                className="transition-colors duration-100"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {renderRow(msg, vi.index)}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);

export default VirtualMessageList;
