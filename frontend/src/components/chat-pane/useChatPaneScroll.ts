import { useCallback, useEffect, useRef, useState } from 'react';
import type { VirtualMessageListHandle } from '../VirtualMessageList';
import { scrollAnchorDecision, MESSAGE_JUMP_EVENT } from '../../utils/messageListWindow';

const SCROLL_THRESHOLD = 150;

interface UseChatPaneScrollArgs {
  /** Id of the newest message in the live (unfrozen) list, or null. */
  liveLastId: string | null;
  /** True while the pane shows the "no longer available" placeholder instead
   *  of a scroll container — the jump listener re-attaches when it flips. */
  unknownPane: boolean;
}

/**
 * Everything about keeping the pane pinned to the present: bottom-anchoring,
 * the settle loop after programmatic scrolls, wheel/touch release, the
 * ResizeObserver re-stick, and the "frozen at" boundary that holds the list
 * still while the user reads older messages.
 *
 * Lifted verbatim from ChatPane. The pane still owns the scroll container and
 * content elements (it renders them); this hook hands it the refs to attach.
 *
 * The "re-stick when the newest rendered row changes" effect is the separate
 * {@link useStickToNewest}: the rendered list depends on `frozenAtId` (owned
 * here) and on search (which needs `listRef`, also owned here), so its last id
 * only exists after this hook has run.
 */
export function useChatPaneScroll({ liveLastId, unknownPane }: UseChatPaneScrollArgs) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const programmaticScrollRef = useRef(false);
  const settleRafRef = useRef<number | undefined>(undefined);
  const listRef = useRef<VirtualMessageListHandle>(null);
  // When the user scrolls up, we pin the rendered list to this message id so
  // incoming messages don't shift/drift the view. Cleared when back at bottom.
  const [frozenAtId, setFrozenAtId] = useState<string | null>(null);
  const lastLiveIdRef = useRef<string | null>(null);

  const checkNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    // Track scroll direction. Keep the baseline current even during programmatic
    // scrolls so the next user-driven event compares correctly.
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;

    if (programmaticScrollRef.current) return;

    const action = scrollAnchorDecision({
      scrollTop: el.scrollTop,
      previousScrollTop: prevTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      nearBottomThreshold: SCROLL_THRESHOLD,
    });
    if (action === 'stick') {
      // Back at the bottom -> stick to the present.
      isNearBottomRef.current = true;
      setShowScrollButton(false);
    } else if (action === 'release') {
      // Deliberate upward scroll -> pause and view older messages. We only pause
      // on a real up-scroll (not merely distance) so that content growing during
      // load/streaming never yanks us off the present.
      isNearBottomRef.current = false;
      setShowScrollButton(true);
    } else {
      setShowScrollButton(!isNearBottomRef.current);
    }
  }, []);

  const cancelSettle = useCallback(() => {
    if (settleRafRef.current !== undefined) {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = undefined;
    }
  }, []);

  const performScroll = useCallback((smooth: boolean) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const useSmooth = smooth && !document.hidden;

    programmaticScrollRef.current = true;
    cancelSettle();

    if (useSmooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }

    const startedAt = performance.now();
    const MAX_DURATION = 2000;
    let lastHeight = el.scrollHeight;
    let stableFrames = 0;

    const step = () => {
      const c = scrollContainerRef.current;
      if (!c) {
        programmaticScrollRef.current = false;
        settleRafRef.current = undefined;
        return;
      }

      const height = c.scrollHeight;
      if (height !== lastHeight) {
        lastHeight = height;
        stableFrames = 0;
        if (useSmooth) {
          c.scrollTo({ top: height, behavior: 'smooth' });
        }
      } else {
        stableFrames++;
      }

      if (!useSmooth) c.scrollTop = c.scrollHeight;

      const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 4;
      const elapsed = performance.now() - startedAt;

      if ((atBottom && stableFrames >= 3) || elapsed > MAX_DURATION) {
        c.scrollTop = c.scrollHeight;
        programmaticScrollRef.current = false;
        isNearBottomRef.current = true;
        setShowScrollButton(false);
        settleRafRef.current = undefined;
      } else {
        settleRafRef.current = requestAnimationFrame(step);
      }
    };

    settleRafRef.current = requestAnimationFrame(step);
  }, [cancelSettle]);

  /** Re-pin to the present, e.g. when the pane moves to another room. */
  const resetToBottom = useCallback(() => {
    isNearBottomRef.current = true;
    setShowScrollButton(false);
    cancelSettle();
    performScroll(false);
  }, [cancelSettle, performScroll]);

  useEffect(() => {
    return () => cancelSettle();
  }, [cancelSettle]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // The instant the user scrolls up, release the auto-scroll lock and stop the
    // settle loop. Reading deltaY directly (instead of recomputing from scroll
    // position) avoids a race where an incoming message re-snaps to the bottom
    // before the user's upward scroll has actually moved the viewport.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY >= 0) return;
      cancelSettle();
      programmaticScrollRef.current = false;
      isNearBottomRef.current = false;
      setShowScrollButton(true);
    };
    // On touch, hand control back so the position-based checkNearBottom logic
    // governs auto-scroll while the user drags.
    const onTouchStart = () => {
      if (!programmaticScrollRef.current) return;
      cancelSettle();
      programmaticScrollRef.current = false;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
    };
  }, [cancelSettle]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      if (settleRafRef.current !== undefined) return;
      if (isNearBottomRef.current) {
        performScroll(false);
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [performScroll]);

  useEffect(() => {
    lastLiveIdRef.current = liveLastId;
  }, [liveLastId]);

  // showScrollButton mirrors "not pinned to bottom" across every scroll code
  // path, so drive the freeze off it: capture the boundary once when the user
  // leaves the bottom, and release it when they return.
  useEffect(() => {
    if (showScrollButton) {
      setFrozenAtId((prev) => prev ?? lastLiveIdRef.current);
    } else {
      setFrozenAtId(null);
    }
  }, [showScrollButton]);

  const scrollToBottom = () => {
    isNearBottomRef.current = true;
    setShowScrollButton(false);
    performScroll(true);
  };

  const jumpToPresent = () => {
    setFrozenAtId(null);
    scrollToBottom();
  };

  // Reply-preview clicks inside <Message> bubble a jump request up to the pane
  // (the target row may not be mounted, so getElementById can't be used there).
  // Re-attach when the scroll container (re)mounts as the pane leaves the
  // unknown state.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ messageId?: string }>).detail;
      if (detail?.messageId) listRef.current?.scrollToMessage(detail.messageId, ['bg-oct-accent-dim']);
    };
    el.addEventListener(MESSAGE_JUMP_EVENT, onJump);
    return () => el.removeEventListener(MESSAGE_JUMP_EVENT, onJump);
  }, [unknownPane]);

  return {
    scrollContainerRef,
    contentRef,
    listRef,
    frozenAtId,
    checkNearBottom,
    resetToBottom,
    jumpToPresent,
    performScroll,
    isNearBottomRef,
  };
}

export type ChatPaneScroll = ReturnType<typeof useChatPaneScroll>;

/**
 * Snap to the bottom when the newest RENDERED message changes while the pane
 * is pinned there. Call after the rendered list is known (see the note on
 * {@link useChatPaneScroll}); it is the same effect the pane always ran.
 */
export function useStickToNewest(
  { performScroll, isNearBottomRef }: Pick<ChatPaneScroll, 'performScroll' | 'isNearBottomRef'>,
  lastMessageId: string | null,
) {
  const prevLastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastMessageId === prevLastIdRef.current) return;
    prevLastIdRef.current = lastMessageId;
    if (lastMessageId && isNearBottomRef.current) {
      performScroll(false);
    }
  }, [lastMessageId, performScroll, isNearBottomRef]);
}
