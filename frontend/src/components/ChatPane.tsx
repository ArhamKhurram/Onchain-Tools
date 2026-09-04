import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useThemeStore } from '../stores/themeStore';
import Message from './Message';
import ChatInput from './ChatInput';
import VirtualMessageList from './VirtualMessageList';
import HiddenUsersPanel from './HiddenUsersPanel';
import ChatPaneHeader, { type ChatPaneVariant } from './chat-pane/ChatPaneHeader';
import ChatPaneSearchBar from './chat-pane/ChatPaneSearchBar';
import ChatPaneBanners from './chat-pane/ChatPaneBanners';
import { useChatPaneScroll, useStickToNewest } from './chat-pane/useChatPaneScroll';
import { useChatPaneSearch } from './chat-pane/useChatPaneSearch';
import { filterRoomMessages, collectChannelHiddenUsers, type FocusFilter } from './chat-pane/messageFilters';
import { useCallerQuality, type CallerQuality } from '../hooks/useCallerQuality';
import { createHighlightColorResolver } from '../utils/userIdentifiers';
import { computeFrozenWindow } from '../utils/messageListWindow';
import { DEFAULT_FEED_ROW_DENSITY, FEED_ROW_HEIGHT_ESTIMATE, useFeedChromeContext } from './feed/feedChromeContract';
import { callerKey } from '@oct/shared';
import type { FrontendMessage } from '../types';
import { Hash } from 'lucide-react';

// Stable fallback so an empty room doesn't hand downstream memos a fresh [].
const NO_MESSAGES: FrontendMessage[] = [];

interface ChatPaneProps {
  roomId: string;
  paneIndex: number;
  paneCount: number;
  editMode: boolean;
  variant?: ChatPaneVariant;
  /**
   * Owner of the pane's room when it is not a Feed split pane (workspace
   * panels). When provided, the header room switcher reports the pick here
   * instead of writing to the Feed's paneRoomIds.
   */
  onRoomChange?: (roomId: string) => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

export default function ChatPane({ roomId, paneIndex, paneCount, editMode, variant = 'grid', onRoomChange, onMoveLeft, onMoveRight }: ChatPaneProps) {
  const isWorkspace = variant === 'workspace';
  const rooms = useAppStore((s) => s.rooms);
  // Subscribe to THIS pane's room only. `addMessage` gives every touched room a
  // fresh array but leaves untouched rooms' references alone, so a whole-map
  // subscription re-renders every pane on every message anywhere — with four
  // split panes that's 4x the renders the traffic calls for.
  const storedRoomMessages = useAppStore((s) => s.messages[roomId]);
  const config = useAppStore((s) => s.config);

  const updateRoom = useAppStore((s) => s.updateRoom);
  const dmChannels = useAppStore((s) => s.dmChannels);
  const hideUser = useAppStore((s) => s.hideUser);
  const unhideUser = useAppStore((s) => s.unhideUser);
  const setCallerTier = useAppStore((s) => s.setCallerTier);
  const { qualityFor } = useCallerQuality();
  const setPaneRoom = useAppStore((s) => s.setPaneRoom);
  const swapPanes = useAppStore((s) => s.swapPanes);
  const setActivePane = useAppStore((s) => s.setActivePane);
  // Pane locks belong to the Feed's split panes. A workspace panel owns its own
  // room, so it must not inherit the lock state of Feed pane 0.
  const feedPaneLocked = useAppStore((s) => s.paneLocks[paneIndex] ?? false);
  const locked = isWorkspace ? false : feedPaneLocked;
  const [dragOver, setDragOver] = useState(false);

  // Where a room pick goes: the owner's callback when there is one, otherwise
  // this pane's slot in the Feed layout.
  const selectRoom = useCallback(
    (nextRoomId: string) => {
      if (onRoomChange) onRoomChange(nextRoomId);
      else setPaneRoom(paneIndex, nextRoomId);
    },
    [onRoomChange, setPaneRoom, paneIndex],
  );

  // Focus filter is local to each pane so split panes stay independent.
  const [focusFilter, setFocusFilterState] = useState<FocusFilter>(null);
  const clearFocusFilter = useCallback(() => setFocusFilterState(null), []);

  const [hiddenPanelOpen, setHiddenPanelOpen] = useState(false);
  const [quickReplyChannelId, setQuickReplyChannelId] = useState<string | null>(null);

  const chattingEnabled = config?.chattingEnabled ?? false;

  const isDMView = roomId.startsWith('dm:');
  const isTgDMView = roomId.startsWith('tg-dm:');
  const isMentionsView = roomId === 'mentions';
  const isAnyDMView = isDMView || isTgDMView;
  const dmChannelId = isDMView ? roomId.slice(3) : isTgDMView ? roomId.slice(6) : null;
  const activeDM = isDMView ? dmChannels.find((dm) => dm.id === dmChannelId) : null;

  const activeRoom = isAnyDMView || isMentionsView ? undefined : rooms.find((r) => r.id === roomId);
  const allRoomMessages = storedRoomMessages ?? NO_MESSAGES;

  // Colour lookup that understands @handle-keyed entries, not just ids — a
  // colour saved against "@handle" must paint that user's rows. Memoised per
  // colour map so rows share one resolver.
  const highlightColorFor = useMemo(
    () => createHighlightColorResolver(activeRoom?.highlightedUserColors),
    [activeRoom?.highlightedUserColors],
  );

  // `qualityFor` builds a fresh object per call, and `callerQuality` is a prop
  // of the memoised <Message> row — fresh identities every render would defeat
  // the memo for every visible row (up to renderLimit rows in each of up to 4
  // panes) on every pane render. Cache one object per caller key and reset the
  // cache only when the inputs behind `qualityFor` change (its identity) or
  // the pane moves to another room.
  const qualityCacheRef = useRef<{ fn: typeof qualityFor; room: string; map: Map<string, CallerQuality> } | null>(null);
  if (!qualityCacheRef.current || qualityCacheRef.current.fn !== qualityFor || qualityCacheRef.current.room !== roomId) {
    qualityCacheRef.current = { fn: qualityFor, room: roomId, map: new Map() };
  }
  const qualityCache = qualityCacheRef.current.map;
  const embedDisabledChannels = new Set(
    activeRoom?.channels.filter((c) => c.disableEmbeds).map((c) => c.channelId)
  );

  const hiddenUsers = config?.hiddenUsers ?? {};
  const afterFocus = filterRoomMessages(allRoomMessages, activeRoom, hiddenUsers, focusFilter);

  const liveLastId = afterFocus.length > 0 ? afterFocus[afterFocus.length - 1].id : null;

  const unknownPane = !activeRoom && !activeDM && !isTgDMView && !isMentionsView;

  const scroll = useChatPaneScroll({ liveLastId, unknownPane });
  const { scrollContainerRef, contentRef, listRef, frozenAtId, checkNearBottom, resetToBottom, jumpToPresent } = scroll;

  // While "frozen" (user scrolled up), hold the rendered list at the boundary
  // and keep newer messages out of the view. They are counted and surfaced via
  // the "new messages" pill / "jump to present" banner instead of drifting in.
  const { baseList, newMessageCount, firstNewMessage } = computeFrozenWindow(afterFocus, frozenAtId);
  const viewingOlder = frozenAtId !== null;

  const search = useChatPaneSearch(afterFocus, listRef);
  const { searchOpen, trimmedSearch, searchResults, openSearch, closeSearch } = search;

  // The list is virtualised (only rows near the viewport are mounted), so the
  // full filtered list renders — no mount-count window to grow on scroll.
  const roomMessages = searchResults ?? baseList;

  const lastMessageId = roomMessages.length > 0 ? roomMessages[roomMessages.length - 1].id : null;
  useStickToNewest(scroll, lastMessageId);

  const channelHiddenUsers = collectChannelHiddenUsers(activeRoom, hiddenUsers);

  const toggleHighlightUser = useCallback(async (userId: string, _displayName: string) => {
    if (!activeRoom) return;
    const current = activeRoom.highlightedUsers ?? [];
    const isAlready = current.includes(userId);
    const highlightedUsers = isAlready ? current.filter((id) => id !== userId) : [...current, userId];
    const updates: Partial<typeof activeRoom> = { highlightedUsers };
    if (isAlready && activeRoom.highlightedUserColors?.[userId]) {
      const { [userId]: _, ...rest } = activeRoom.highlightedUserColors;
      updates.highlightedUserColors = rest;
    }
    await updateRoom(activeRoom.id, updates);
  }, [activeRoom, updateRoom]);

  const handleQuickReply = useCallback((channelId: string) => {
    setQuickReplyChannelId(channelId);
  }, []);

  const handleFocus = useCallback((guildId: string | null, channelId: string, guildName: string | null, channelName: string) => {
    setFocusFilterState((prev) =>
      prev && prev.guildId === guildId && prev.channelId === channelId
        ? null
        : { guildId, channelId, guildName, channelName }
    );
  }, []);

  useEffect(() => {
    resetToBottom();
    clearFocusFilter();
    closeSearch();
  }, [roomId, clearFocusFilter, resetToBottom, closeSearch]);

  const dmRecipientNames = activeDM
    ? activeDM.recipients.map((r) => r.global_name || r.username || 'Unknown').join(', ')
    : isTgDMView
      ? (allRoomMessages[0]?.channelName ?? allRoomMessages[0]?.author.displayName ?? 'Telegram Chat')
      : null;

  const headerTitle = isMentionsView
    ? 'Mentions'
    : isAnyDMView
      ? (dmRecipientNames ?? 'Direct Message')
      : (activeRoom?.name ?? 'Unknown');

  // In the Feed shell the chrome row already names the room, so the pane header
  // keeps only its own controls. The chrome preset also sets row density;
  // resolved here ONCE and handed to the rows as a plain prop (rows are
  // virtualised and re-render per frame — no context reads down there).
  const chrome = useFeedChromeContext();
  const chromeOwnsHeader = chrome?.ownsPaneHeader ?? false;
  const density = chrome?.density ?? DEFAULT_FEED_ROW_DENSITY;
  const estimatedRowHeight = FEED_ROW_HEIGHT_ESTIMATE[density];

  const handleDrop = (e: React.DragEvent) => {
    if (!editMode || locked) return;
    e.preventDefault();
    setDragOver(false);
    const data = e.dataTransfer.getData('text/plain');
    if (data.startsWith('room:')) {
      selectRoom(data.slice(5));
    } else if (data.startsWith('pane:')) {
      const from = Number(data.slice(5));
      if (!Number.isNaN(from)) swapPanes(from, paneIndex);
    }
  };

  const ringClass = editMode ? 'outline outline-2 outline-offset-[-2px] outline-oct-accent' : '';
  const theme = useThemeStore((s) => s.theme);
  const paneBg =
    theme === 'light'
      ? 'rgb(var(--oct-feed-bg))'
      : activeRoom?.color || 'rgb(var(--oct-feed-bg))';

  // Workspace panels reuse ChatPane with paneIndex 0; marking that pane active
  // would silently retarget the FEED's pane-0 to workspace clicks.
  const handlePaneFocus = isWorkspace ? undefined : () => setActivePane(paneIndex);

  return (
    <div
      className={`flex-1 flex flex-col min-w-0 h-full relative ${ringClass}`}
      style={{ backgroundColor: paneBg }}
      onMouseDownCapture={handlePaneFocus}
      onDragOver={(e) => { if (editMode && !locked) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (editMode && !e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={handleDrop}
    >
      {editMode && !locked && dragOver && (
        <div className="absolute inset-0 z-40 bg-oct-accent-dim border-2 border-dashed border-oct-accent pointer-events-none flex items-center justify-center">
          <span className="rounded-cockpit border-2 border-oct-border bg-oct-accent px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wide text-white">Drop here</span>
        </div>
      )}

      <ChatPaneHeader
        roomId={roomId}
        paneIndex={paneIndex}
        paneCount={paneCount}
        editMode={editMode}
        variant={variant}
        locked={locked}
        chromeOwnsHeader={chromeOwnsHeader}
        activeRoom={activeRoom}
        isDMView={isDMView}
        isTgDMView={isTgDMView}
        isMentionsView={isMentionsView}
        headerTitle={headerTitle}
        focusActive={focusFilter !== null}
        onClearFocus={clearFocusFilter}
        hiddenCount={channelHiddenUsers.length}
        hiddenPanelOpen={hiddenPanelOpen}
        onToggleHiddenPanel={() => setHiddenPanelOpen(!hiddenPanelOpen)}
        searchOpen={searchOpen}
        onOpenSearch={openSearch}
        onCloseSearch={closeSearch}
        onSelectRoom={selectRoom}
        onMoveLeft={onMoveLeft}
        onMoveRight={onMoveRight}
      />

      {searchOpen && (
        <ChatPaneSearchBar
          inputRef={search.searchInputRef}
          query={search.searchQuery}
          setQuery={search.setSearchQuery}
          activeMatchIndex={search.activeMatchIndex}
          setActiveMatchIndex={search.setActiveMatchIndex}
          trimmedQuery={trimmedSearch}
          results={searchResults}
          jumpToMatch={search.jumpToMatch}
          onClose={closeSearch}
        />
      )}

      {hiddenPanelOpen && channelHiddenUsers.length > 0 && (
        <HiddenUsersPanel
          entries={channelHiddenUsers}
          onClose={() => setHiddenPanelOpen(false)}
          onUnhide={unhideUser}
        />
      )}

      {/* Messages */}
      {unknownPane ? (
        <div className="flex-1 flex items-center justify-center text-center text-oct-muted p-4">
          <div>
            <Hash size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">This chat is no longer available. Pick another from the header.</p>
          </div>
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto"
          onScroll={checkNearBottom}
          style={{ overflowAnchor: 'none' }}
        >
          {roomMessages.length === 0 && (
            <div className="flex items-center justify-center h-full font-mono text-xs uppercase tracking-[0.15em] text-oct-muted">
              {searchOpen && trimmedSearch
                ? 'No messages match your search.'
                : isMentionsView
                  ? 'No mentions yet.'
                  : 'Waiting for messages...'}
            </div>
          )}

          <VirtualMessageList
            ref={listRef}
            items={roomMessages}
            scrollElementRef={scrollContainerRef}
            contentRef={contentRef}
            estimatedRowHeight={estimatedRowHeight}
            renderRow={(msg: FrontendMessage, i: number) => {
              const prev = i > 0 ? roomMessages[i - 1] : null;
              const sameAuthor = prev?.author.id === msg.author.id;
              const timeDiff = prev
                ? new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime()
                : Infinity;
              const isCompact = sameAuthor && timeDiff < 5 * 60 * 1000 && prev?.channelId === msg.channelId;

              // A forum-topic message's channelId is `chatId:topicId`; a color saved
              // for the whole group (bare chatId — every pre-topics color) must
              // still apply, so fall back to the group half of the id.
              const tgGroupId = msg.channelId.split(':')[0];
              const guildColor = msg.source === 'telegram'
                ? config?.telegramColors?.[msg.channelId]
                  ?? config?.telegramColors?.[tgGroupId]
                  ?? config?.dmColors?.[msg.channelId]
                : msg.guildId
                  ? config?.guildColors?.[msg.guildId]
                  : config?.dmColors?.[msg.channelId];
              const highlightColor = highlightColorFor(msg.author.id, msg.author.username);

              const qualityKey = callerKey(msg.source === 'telegram' ? 'telegram' : 'discord', msg.author.id);
              let callerQuality = qualityCache.get(qualityKey);
              if (!callerQuality) {
                callerQuality = qualityFor(qualityKey, activeRoom ? [activeRoom.id] : []);
                qualityCache.set(qualityKey, callerQuality);
              }

              return (
                  <Message
                    message={msg}
                    isCompact={isCompact}
                    density={density}
                    messageDisplay={config?.messageDisplay ?? 'default'}
                    compactModeAvatars={config?.compactModeAvatars ?? true}
                    guildColor={guildColor}
                    highlightMode={activeRoom?.highlightMode ?? 'background'}
                    highlightColor={highlightColor}
                    disableEmbeds={embedDisabledChannels.has(msg.channelId)}
                    evmAddressColor={config?.evmAddressColor ?? '#fee75c'}
                    solAddressColor={config?.solAddressColor ?? '#14f195'}
                    contractLinkTemplates={config?.contractLinkTemplates}
                    contractClickAction={config?.contractClickAction ?? 'copy_open'}
                    showFullContractAddress={config?.showFullContractAddress ?? false}
                    openInDiscordApp={config?.openInDiscordApp ?? false}
                    openInTelegramApp={config?.openInTelegramApp ?? false}
                    badgeClickAction={config?.badgeClickAction ?? 'discord'}
                    onHideUser={hideUser}
                    onToggleHighlight={activeRoom ? toggleHighlightUser : undefined}
                    isUserHighlighted={
                      activeRoom?.highlightedUsers?.some((e) =>
                        e === msg.author.id ||
                        (e.startsWith('@') && msg.author.username && e.slice(1).toLowerCase() === msg.author.username.toLowerCase())
                      ) ?? false
                    }
                    onFocus={handleFocus}
                    isFocused={focusFilter !== null && focusFilter.guildId === msg.guildId && focusFilter.channelId === msg.channelId}
                    onQuickReply={handleQuickReply}
                    chattingEnabled={chattingEnabled}
                    roleColors={config?.roleColors ?? true}
                    callerQuality={callerQuality}
                    onSetCallerTier={setCallerTier}
                  />
              );
            }}
          />
        </div>
      )}

      <ChatPaneBanners
        newMessageCount={newMessageCount}
        firstNewMessageTs={firstNewMessage ? firstNewMessage.timestamp : null}
        viewingOlder={viewingOlder}
        hasMessages={roomMessages.length > 0}
        searchOpen={searchOpen}
        chromeOwnsHeader={chromeOwnsHeader}
        chattingEnabled={chattingEnabled}
        onJumpToPresent={jumpToPresent}
      />

      {/* Chat input */}
      {chattingEnabled && (
        isAnyDMView && dmChannelId ? (
          <ChatInput
            channels={[]}
            isDM
            dmChannelId={dmChannelId}
            dmSource={isTgDMView ? 'telegram' : 'discord'}
          />
        ) : activeRoom ? (
          <ChatInput
            channels={activeRoom.channels}
            defaultChannelId={quickReplyChannelId ?? focusFilter?.channelId ?? null}
          />
        ) : null
      )}
    </div>
  );
}
