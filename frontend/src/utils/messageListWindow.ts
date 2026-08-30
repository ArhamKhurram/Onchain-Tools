// Pure helpers for the chat pane's message window and scroll anchoring.
// Extracted from ChatPane so the decisions that guard live-chat behaviour
// (freeze-at-boundary, stick-to-bottom) stay unit-testable.

export interface FrozenWindow<T> {
  /** Messages up to and including the freeze boundary (or all of them). */
  baseList: T[];
  /** Messages that arrived after the boundary (surfaced via the pill). */
  newMessageCount: number;
  /** First message past the boundary, for the "since 12:34" label. */
  firstNewMessage: T | null;
}

/**
 * While the user is scrolled up we pin the rendered list to the message they
 * were at (`frozenAtId`) so incoming messages don't shift the view. Messages
 * past the boundary are counted, not rendered.
 *
 * If `frozenAtId` is unset — or no longer present (e.g. evicted by the
 * per-room cap) — the full list renders and nothing is counted as new.
 */
export function computeFrozenWindow<T extends { id: string }>(
  messages: T[],
  frozenAtId: string | null,
): FrozenWindow<T> {
  let frozenIndex = -1;
  if (frozenAtId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id === frozenAtId) {
        frozenIndex = i;
        break;
      }
    }
  }
  if (frozenIndex < 0) {
    return { baseList: messages, newMessageCount: 0, firstNewMessage: null };
  }
  const newMessageCount = messages.length - 1 - frozenIndex;
  return {
    baseList: messages.slice(0, frozenIndex + 1),
    newMessageCount,
    firstNewMessage: newMessageCount > 0 ? messages[frozenIndex + 1] : null,
  };
}

export type ScrollAnchorAction =
  /** Within the bottom threshold: stick to the present. */
  | 'stick'
  /** Deliberate upward scroll away from the bottom: pause auto-scroll. */
  | 'release'
  /** Neither: keep whatever anchor state we already had. */
  | 'keep';

export interface ScrollAnchorInput {
  scrollTop: number;
  previousScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Distance from the bottom under which the pane counts as "at bottom". */
  nearBottomThreshold: number;
}

/**
 * Decide what an observed scroll position means for auto-scroll.
 *
 * We only release on a real upward movement (not mere distance from the
 * bottom) so content growing during load/streaming never yanks the user off
 * the present; and we re-stick as soon as they return within the threshold.
 */
export function scrollAnchorDecision(input: ScrollAnchorInput): ScrollAnchorAction {
  const distanceFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  if (distanceFromBottom < input.nearBottomThreshold) return 'stick';
  const scrolledUp = input.scrollTop < input.previousScrollTop - 2;
  if (scrolledUp) return 'release';
  return 'keep';
}

/**
 * Rows are virtualised, so a reply-preview click inside <Message> can target a
 * row that is not in the DOM. Instead of `getElementById`, the click bubbles
 * this event up to the owning ChatPane, which scrolls the virtual list.
 */
export const MESSAGE_JUMP_EVENT = 'oct:jump-to-message';

export function requestMessageJump(origin: HTMLElement, messageId: string): void {
  origin.dispatchEvent(
    new CustomEvent(MESSAGE_JUMP_EVENT, { bubbles: true, detail: { messageId } }),
  );
}
