import type { RefObject } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import type { FrontendMessage } from '../../types';

interface ChatPaneSearchBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (q: string) => void;
  activeMatchIndex: number;
  setActiveMatchIndex: (i: number) => void;
  trimmedQuery: string;
  results: FrontendMessage[] | null;
  jumpToMatch: (index: number) => void;
  onClose: () => void;
}

/** The strip under the pane header while search is open. Presentational —
 *  `useChatPaneSearch` owns the state. */
export default function ChatPaneSearchBar({
  inputRef, query, setQuery, activeMatchIndex, setActiveMatchIndex, trimmedQuery, results, jumpToMatch, onClose,
}: ChatPaneSearchBarProps) {
  return (
    <div className="px-2 sm:px-4 py-2 border-b-2 border-oct-border bg-oct-surface shrink-0 flex items-center gap-2">
      <Search size={16} className="text-oct-muted shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActiveMatchIndex(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (e.shiftKey) jumpToMatch(activeMatchIndex - 1);
            else jumpToMatch(activeMatchIndex + 1);
          }
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Search messages..."
        className="flex-1 px-3 py-1.5 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
        autoFocus
      />
      {trimmedQuery && results && (
        <div className="flex items-center gap-1 shrink-0">
          <span className="type-caption font-mono uppercase tracking-wide text-oct-muted tabular-nums">
            {results.length === 0
              ? 'No results'
              : `${results.length} result${results.length !== 1 ? 's' : ''}`}
          </span>
          {results.length > 1 && (
            <>
              <button
                onClick={() => jumpToMatch(activeMatchIndex - 1)}
                className="p-0.5 text-oct-muted hover:text-oct-accent transition-colors duration-100"
                title="Previous match (Shift+Enter)"
              >
                <ChevronUp size={16} />
              </button>
              <button
                onClick={() => jumpToMatch(activeMatchIndex + 1)}
                className="p-0.5 text-oct-muted hover:text-oct-accent transition-colors duration-100"
                title="Next match (Enter)"
              >
                <ChevronDown size={16} />
              </button>
            </>
          )}
        </div>
      )}
      <button
        onClick={onClose}
        className="p-0.5 text-oct-muted hover:text-oct-accent transition-colors duration-100 shrink-0"
        title="Close search (Esc)"
      >
        <X size={16} />
      </button>
    </div>
  );
}
