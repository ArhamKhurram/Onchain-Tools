import { ArrowDown } from 'lucide-react';

function formatTime(ts: string | number | Date) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

interface ChatPaneBannersProps {
  /** Messages held back past the freeze boundary while viewing older ones. */
  newMessageCount: number;
  /** Timestamp of the first held-back message, for the "since HH:MM" suffix. */
  firstNewMessageTs: string | number | Date | null;
  viewingOlder: boolean;
  /** The rendered list is non-empty (the older-messages banner needs rows to sit over). */
  hasMessages: boolean;
  searchOpen: boolean;
  /** Feed chrome owns the pane identity, so the header is the short variant. */
  chromeOwnsHeader: boolean;
  chattingEnabled: boolean;
  onJumpToPresent: () => void;
}

/** The two overlays shown while the pane is frozen on older messages: the
 *  new-messages pill under the header and the "viewing older" banner above
 *  the input. Both are absolutely positioned within the pane. */
export default function ChatPaneBanners({
  newMessageCount, firstNewMessageTs, viewingOlder, hasMessages, searchOpen, chromeOwnsHeader, chattingEnabled, onJumpToPresent,
}: ChatPaneBannersProps) {
  return (
    <>
      {/* New-messages pill (shown while viewing older messages) */}
      {newMessageCount > 0 && !searchOpen && (
        <button
          onClick={onJumpToPresent}
          className={`absolute ${chromeOwnsHeader ? 'top-9' : 'top-12'} left-0 right-0 z-20 flex items-center justify-between gap-2 px-3 sm:px-4 py-1.5 border-b-2 border-oct-border bg-oct-accent hover:bg-oct-accent-hover text-white font-mono text-2xs sm:text-xs font-bold uppercase tracking-wide transition-colors duration-100`}
        >
          <span className="truncate">
            {newMessageCount} new message{newMessageCount !== 1 ? 's' : ''}
            {firstNewMessageTs !== null ? ` since ${formatTime(firstNewMessageTs)}` : ''}
          </span>
          <span className="flex items-center gap-1 shrink-0">Jump <ArrowDown size={14} /></span>
        </button>
      )}

      {/* "Viewing older messages" banner (replaces the plain jump button) */}
      {viewingOlder && !searchOpen && hasMessages && (
        <div
          className={`absolute ${chattingEnabled ? 'bottom-16' : 'bottom-4'} left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 rounded-cockpit border-2 border-oct-border-bright bg-oct-surface`}
        >
          <span className="font-mono text-2xs sm:text-xs uppercase tracking-wide text-oct-muted whitespace-nowrap">You're viewing older messages</span>
          <button
            onClick={onJumpToPresent}
            className="brutal-btn inline-flex items-center gap-1 px-2.5 py-1 text-2xs sm:text-xs whitespace-nowrap"
          >
            Jump To Present <ArrowDown size={14} />
          </button>
        </div>
      )}
    </>
  );
}
