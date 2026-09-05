import { useCallback, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { FrontendMessage } from '../../types';
import type { VirtualMessageListHandle } from '../VirtualMessageList';

/**
 * In-pane message search: open/close state, the query, the match list over
 * the pane's visible messages, and Enter / Shift+Enter navigation that scrolls
 * through the virtualised list. Lifted verbatim from ChatPane.
 */
export function useChatPaneSearch(visibleMessages: FrontendMessage[], listRef: RefObject<VirtualMessageListHandle | null>) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const trimmedSearch = searchQuery.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!searchOpen || !trimmedSearch) return null;
    const matches: FrontendMessage[] = [];
    for (const msg of visibleMessages) {
      if (
        msg.content.toLowerCase().includes(trimmedSearch) ||
        msg.author.displayName.toLowerCase().includes(trimmedSearch) ||
        msg.author.username.toLowerCase().includes(trimmedSearch)
      ) {
        matches.push(msg);
      }
    }
    return matches;
  }, [visibleMessages, trimmedSearch, searchOpen]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setActiveMatchIndex(0);
  }, []);

  const jumpToMatch = useCallback((index: number) => {
    if (!searchResults || searchResults.length === 0) return;
    const clamped = ((index % searchResults.length) + searchResults.length) % searchResults.length;
    setActiveMatchIndex(clamped);
    // The match's row may not be mounted (virtualised list), so scroll via the
    // list handle rather than getElementById.
    listRef.current?.scrollToMessage(searchResults[clamped].id, ['outline', 'outline-2', 'outline-oct-accent']);
  }, [searchResults, listRef]);

  return {
    searchOpen,
    searchQuery,
    setSearchQuery,
    activeMatchIndex,
    setActiveMatchIndex,
    searchInputRef,
    trimmedSearch,
    searchResults,
    openSearch,
    closeSearch,
    jumpToMatch,
  };
}
