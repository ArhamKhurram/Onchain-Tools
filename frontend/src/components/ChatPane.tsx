import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useThemeStore } from '../stores/themeStore';
import Message from './Message';
import ChatInput from './ChatInput';
import VirtualMessageList, { type VirtualMessageListHandle } from './VirtualMessageList';
import { useCallerQuality, type CallerQuality } from '../hooks/useCallerQuality';
import { createHighlightColorResolver } from '../utils/userIdentifiers';
import { computeFrozenWindow, scrollAnchorDecision, MESSAGE_JUMP_EVENT } from '../utils/messageListWindow';
import { useFeedChromeContext } from './feed/feedChromeContract';
import { callerKey } from '@oct/shared';
import type { FrontendMessage } from '../types';
import { Hash, MessageCircle, Settings, ArrowDown, Filter, EyeOff, X, Trash2, Eye, Search, ChevronUp, ChevronDown, Send, AtSign, GripVertical, Plus, Rows2, Columns2, ArrowLeft, ArrowRight, Lock, Unlock, ExternalLink } from 'lucide-react';

const MAX_PANES = 4;

const SCROLL_THRESHOLD = 150;

function formatTime(ts: string | number | Date) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

type FocusFilter = { guildId: string | null; channelId: string; guildName: string | null; channelName: string } | null;

// Instant styled hover label ("legend") for the compact header icon buttons.
function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative group/tip flex items-center">
      {children}
      <span className="pointer-events-none absolute top-full right-0 mt-1.5 z-50 whitespace-nowrap rounded-cockpit border-2 border-oct-border bg-oct-surface-raised px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-text shadow-oct-hard-sm opacity-0 group-hover/tip:opacity-100 transition-opacity duration-100">
        {label}
      </span>
    </div>
  );
}

interface ChatPaneProps {
  roomId: string;
  paneIndex: number;
  paneCount: number;
  editMode: boolean;
  variant?: 'grid' | 'popout' | 'workspace';
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
  const isPopout = variant === 'popout';
  const isWorkspace = variant === 'workspace';
  const rooms = useAppStore((s) => s.rooms);
  const messages = useAppStore((s) => s.messages);
  const config = useAppStore((s) => s.config);
  const openConfigModal = useAppStore((s) => s.openConfigModal);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const prevLastIdRef = useRef<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const programmaticScrollRef = useRef(false);
  const settleRafRef = useRef<number | undefined>(undefined);
  const listRef = useRef<VirtualMessageListHandle>(null);
  // When the user scrolls up, we pin the rendered list to this message id so
  // incoming messages don't shift/drift the view. Cleared when back at bottom.
  const [frozenAtId, setFrozenAtId] = useState<string | null>(null);
  const lastLiveIdRef = useRef<string | null>(null);

  const updateRoom = useAppStore((s) => s.updateRoom);
  const dmChannels = useAppStore((s) => s.dmChannels);
  const hideUser = useAppStore((s) => s.hideUser);
  const unhideUser = useAppStore((s) => s.unhideUser);
  const setCallerTier = useAppStore((s) => s.setCallerTier);
  const { qualityFor } = useCallerQuality();
  const setPaneRoom = useAppStore((s) => s.setPaneRoom);
  const swapPanes = useAppStore((s) => s.swapPanes);
  const addPane = useAppStore((s) => s.addPane);
  const removePane = useAppStore((s) => s.removePane);
  const popOutPane = useAppStore((s) => s.popOutPane);
  const poppedOutRoomIds = useAppStore((s) => s.poppedOutRoomIds);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const isGrid = useAppStore((s) => s.config?.splitLayout === 'grid');
  const setActivePane = useAppStore((s) => s.setActivePane);
  const togglePaneLock = useAppStore((s) => s.togglePaneLock);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [quickReplyChannelId, setQuickReplyChannelId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const chattingEnabled = config?.chattingEnabled ?? false;

  const isDMView = roomId.startsWith('dm:');
  const isTgDMView = roomId.startsWith('tg-dm:');
  const isMentionsView = roomId === 'mentions';
  const isAnyDMView = isDMView || isTgDMView;
  const dmChannelId = isDMView ? roomId.slice(3) : isTgDMView ? roomId.slice(6) : null;
  const activeDM = isDMView ? dmChannels.find((dm) => dm.id === dmChannelId) : null;

  const activeRoom = isAnyDMView || isMentionsView ? undefined : rooms.find((r) => r.id === roomId);
  const allRoomMessages = messages[roomId] ?? [];

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

  const isFilterActive = activeRoom?.filterEnabled && (activeRoom?.filteredUsers?.length ?? 0) > 0;
  const filterSet = new Set(activeRoom?.filteredUsers?.map((u) => u.toLowerCase()) ?? []);

  const hiddenUsers = config?.hiddenUsers ?? {};
  const isUserHidden = (msg: typeof allRoomMessages[0]) => {
    const key = `${msg.guildId ?? 'null'}:${msg.channelId}`;
    return hiddenUsers[key]?.some((e) => e.userId === msg.author.id) ?? false;
  };

  const afterFilter = isFilterActive
    ? allRoomMessages.filter((msg) =>
        filterSet.has(msg.author.id) ||
        filterSet.has(msg.author.username.toLowerCase()) ||
        filterSet.has(msg.author.displayName.toLowerCase())
      )
    : allRoomMessages;

  const afterHidden = afterFilter.filter((msg) => !isUserHidden(msg));

  const afterFocus = focusFilter
    ? afterHidden.filter((msg) => msg.guildId === focusFilter.guildId && msg.channelId === focusFilter.channelId)
    : afterHidden;

  const trimmedSearch = searchQuery.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!searchOpen || !trimmedSearch) return null;
    const matches: typeof afterFocus = [];
    for (const msg of afterFocus) {
      if (
        msg.content.toLowerCase().includes(trimmedSearch) ||
        msg.author.displayName.toLowerCase().includes(trimmedSearch) ||
        msg.author.username.toLowerCase().includes(trimmedSearch)
      ) {
        matches.push(msg);
      }
    }
    return matches;
  }, [afterFocus, trimmedSearch, searchOpen]);

  const liveLastId = afterFocus.length > 0 ? afterFocus[afterFocus.length - 1].id : null;

  // While "frozen" (user scrolled up), hold the rendered list at the boundary
  // and keep newer messages out of the view. They are counted and surfaced via
  // the "new messages" pill / "jump to present" banner instead of drifting in.
  const { baseList, newMessageCount, firstNewMessage } = computeFrozenWindow(afterFocus, frozenAtId);
  const viewingOlder = frozenAtId !== null;

  // The list is virtualised (only rows near the viewport are mounted), so the
  // full filtered list renders — no mount-count window to grow on scroll.
  const roomMessages = searchResults ?? baseList;

  const lastMessageId = roomMessages.length > 0 ? roomMessages[roomMessages.length - 1].id : null;

  const channelHiddenUsers = activeRoom
    ? activeRoom.channels.flatMap((ch) => {
        const key = `${ch.guildId ?? 'null'}:${ch.channelId}`;
        return (hiddenUsers[key] ?? []).map((entry) => ({
          userId: entry.userId,
          displayName: entry.displayName,
          guildId: ch.guildId,
          channelId: ch.channelId,
          channelName: ch.channelName ?? ch.channelId,
          guildName: ch.guildName ?? null,
        }));
      })
    : [];

  const toggleFilter = () => {
    if (activeRoom) {
      updateRoom(activeRoom.id, { filterEnabled: !activeRoom.filterEnabled });
    }
  };

  const toggleHighlightUser = useCallback(async (userId: string, displayName: string) => {
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
  }, [searchResults]);

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

  useEffect(() => {
    if (lastMessageId === prevLastIdRef.current) return;
    prevLastIdRef.current = lastMessageId;
    if (lastMessageId && isNearBottomRef.current) {
      performScroll(false);
    }
  }, [lastMessageId, performScroll]);

  useEffect(() => {
    isNearBottomRef.current = true;
    setShowScrollButton(false);
    cancelSettle();
    performScroll(false);
    clearFocusFilter();
    closeSearch();
  }, [roomId, clearFocusFilter, performScroll, cancelSettle, closeSearch]);

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

  // Options for the per-pane room switcher dropdown.
  const switcherOptions = useMemo(() => {
    const opts: { id: string; label: string; kind: 'mentions' | 'room' | 'dm' | 'tg' }[] = [];
    opts.push({ id: 'mentions', label: 'Mentions', kind: 'mentions' });
    for (const r of rooms) opts.push({ id: r.id, label: r.name, kind: 'room' });
    const dmLookup = new Map(dmChannels.map((dm) => [dm.id, dm]));
    for (const key of Object.keys(messages)) {
      if ((messages[key]?.length ?? 0) === 0) continue;
      if (key.startsWith('dm:')) {
        const dm = dmLookup.get(key.slice(3));
        const label = dm ? dm.recipients.map((r) => r.global_name || r.username || 'Unknown').join(', ') : (messages[key][0]?.author.displayName ?? 'DM');
        opts.push({ id: key, label, kind: 'dm' });
      } else if (key.startsWith('tg-dm:')) {
        const label = messages[key][0]?.channelName ?? messages[key][0]?.author.displayName ?? 'Telegram Chat';
        opts.push({ id: key, label, kind: 'tg' });
      }
    }
    return opts;
  }, [rooms, dmChannels, messages]);

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

  const HeaderIcon = isMentionsView ? AtSign : isTgDMView ? Send : isDMView ? MessageCircle : Hash;
  const headerIconClass = isTgDMView ? 'text-oct-accent' : 'text-oct-muted';

  // In the Feed shell the chrome row already names the room, so the pane header
  // keeps only its own controls.
  const chromeOwnsHeader = useFeedChromeContext()?.ownsPaneHeader ?? false;

  const canDrag = editMode && paneCount > 1 && !locked && !isWorkspace;
  const canPopOut = variant === 'grid' && !!window.oct?.openPopout && !poppedOutRoomIds.includes(roomId);

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

  const unknownPane = !activeRoom && !activeDM && !isTgDMView && !isMentionsView;

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
      {/* Channel header */}
      <div className={`${chromeOwnsHeader ? 'h-9' : 'h-12'} px-2 sm:px-4 flex items-center border-b-2 border-oct-border shrink-0 bg-transparent z-10 gap-1`}>
        {canDrag && (
          <div
            draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/plain', `pane:${paneIndex}`); e.dataTransfer.effectAllowed = 'move'; }}
            className="p-0.5 -ml-0.5 mr-0.5 rounded-cockpit text-oct-muted hover:text-oct-text cursor-grab active:cursor-grabbing shrink-0"
            title="Drag to rearrange pane"
          >
            <GripVertical size={16} />
          </div>
        )}

        {/* Room switcher */}
        {!chromeOwnsHeader && (
          <div className="relative min-w-0 flex items-center">
            <button
              onClick={() => { if (!locked) setSwitcherOpen((v) => !v); }}
              className="flex items-center gap-1.5 min-w-0 rounded-cockpit px-1 py-0.5 hover:bg-oct-surface-raised transition-colors duration-100"
              title={locked ? 'Pane locked - unlock to change room' : 'Switch pane content'}
            >
              <HeaderIcon size={20} className={`${headerIconClass} shrink-0`} />
              <span className="font-mono text-sm sm:text-base font-bold uppercase tracking-wide text-oct-text truncate max-w-[40vw] sm:max-w-none">
                {headerTitle}
              </span>
              {locked ? <Lock size={13} className="text-oct-muted shrink-0" /> : <ChevronDown size={14} className="text-oct-muted shrink-0" />}
            </button>
            {switcherOpen && !locked && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setSwitcherOpen(false)} />
                <div className="absolute top-full left-0 mt-1 z-30 w-56 max-h-[60vh] overflow-y-auto rounded-cockpit border-2 border-oct-border bg-oct-surface-raised shadow-oct-hard-lg py-1">
                  {switcherOptions.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => { selectRoom(opt.id); setSwitcherOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left font-mono text-xs uppercase tracking-wide truncate transition-colors duration-100 ${
                        opt.id === roomId
                          ? 'bg-oct-accent-dim text-oct-accent'
                          : 'text-oct-text hover:bg-oct-accent-dim hover:text-oct-accent'
                      }`}
                    >
                      {opt.kind === 'mentions' ? <AtSign size={16} className="shrink-0 opacity-70" />
                        : opt.kind === 'tg' ? <Send size={16} className="shrink-0 text-oct-accent" />
                        : opt.kind === 'dm' ? <MessageCircle size={16} className="shrink-0 opacity-70" />
                        : <Hash size={16} className="shrink-0 opacity-70" />}
                      <span className="truncate">{opt.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {!chromeOwnsHeader && !isAnyDMView && !isMentionsView && activeRoom && (
          <span className="ml-2 font-mono text-[10px] sm:text-xs uppercase tracking-[0.15em] text-oct-muted truncate hidden lg:inline">
            {activeRoom.channels.length} channel{activeRoom.channels.length !== 1 ? 's' : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {activeRoom && activeRoom.highlightedUsers.length > 0 && (
            <span className="items-center gap-1 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim px-1.5 sm:px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-accent shrink-0 hidden lg:inline-flex">
              {activeRoom.highlightedUsers.length} highlighted
            </span>
          )}
          {activeRoom && (activeRoom.filteredUsers?.length ?? 0) > 0 && (
            <button
              onClick={toggleFilter}
              className={`inline-flex items-center gap-1 rounded-cockpit border-2 px-1.5 sm:px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide shrink-0 transition-colors duration-100 ${
                activeRoom.filterEnabled
                  ? 'border-oct-green bg-oct-green/15 text-oct-green'
                  : 'border-oct-border bg-oct-surface-raised text-oct-muted hover:text-oct-text'
              }`}
              title={activeRoom.filterEnabled ? 'Click to disable user filter' : 'Click to enable user filter'}
            >
              <Filter size={10} />
              <span className="hidden lg:inline">{activeRoom.filteredUsers.length} filtered</span> {activeRoom.filterEnabled ? 'ON' : 'OFF'}
            </button>
          )}
          {focusFilter && (
            <button
              onClick={clearFocusFilter}
              className="inline-flex items-center gap-1 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim px-1.5 sm:px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-accent hover:border-oct-accent-hover hover:text-oct-accent-hover transition-colors duration-100 max-w-[120px] sm:max-w-none"
              title="Click to exit focus mode"
            >
              <Eye size={10} className="shrink-0" />
              <span className="truncate">Focus</span>
              <X size={10} className="shrink-0" />
            </button>
          )}
          {channelHiddenUsers.length > 0 && (
            <button
              onClick={() => setHiddenPanelOpen(!hiddenPanelOpen)}
              className={`inline-flex items-center gap-1 rounded-cockpit border-2 px-1.5 sm:px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide shrink-0 transition-colors duration-100 ${
                hiddenPanelOpen
                  ? 'border-oct-flame bg-oct-flame/15 text-oct-flame'
                  : 'border-oct-border bg-oct-surface-raised text-oct-muted hover:text-oct-text'
              }`}
              title="View hidden users"
            >
              <EyeOff size={10} />
              <span className="hidden lg:inline">{channelHiddenUsers.length} hidden</span>
            </button>
          )}
          <Tip label={searchOpen ? 'Close search' : 'Search messages (Ctrl+F)'}>
            <button
              onClick={searchOpen ? closeSearch : openSearch}
              className={`p-1 transition-colors duration-100 ${
                searchOpen ? 'text-oct-accent' : 'text-oct-muted hover:text-oct-accent'
              }`}
            >
              <Search size={18} />
            </button>
          </Tip>
          {activeRoom && (
            <Tip label="Room settings">
              <button
                onClick={() => openConfigModal(activeRoom)}
                className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
              >
                <Settings size={18} />
              </button>
            </Tip>
          )}
          {canPopOut && (
            <Tip label="Pop out to its own window">
              <button
                onClick={() => popOutPane(paneIndex)}
                className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
              >
                <ExternalLink size={18} />
              </button>
            </Tip>
          )}
          {editMode && !isWorkspace && onMoveLeft && (
            <Tip label="Move chat to left side">
              <button
                onClick={onMoveLeft}
                className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
              >
                <ArrowLeft size={18} />
              </button>
            </Tip>
          )}
          {editMode && !isWorkspace && onMoveRight && (
            <Tip label="Move chat to right side">
              <button
                onClick={onMoveRight}
                className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
              >
                <ArrowRight size={18} />
              </button>
            </Tip>
          )}
          {paneIndex === 0 && paneCount > 1 && !isWorkspace && (
            <Tip label={isGrid ? 'Single row layout' : 'Two rows layout'}>
              <button
                onClick={() => updateConfig({ splitLayout: isGrid ? 'row' : 'grid' })}
                className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
              >
                {isGrid ? <Columns2 size={18} /> : <Rows2 size={18} />}
              </button>
            </Tip>
          )}
          {!isPopout && !isWorkspace && (
            <Tip label={locked ? 'Unlock pane' : 'Lock pane (prevent changing room)'}>
              <button
                onClick={() => togglePaneLock(paneIndex)}
                className={`p-1 transition-colors duration-100 ${locked ? 'text-oct-accent hover:text-oct-accent-hover' : 'text-oct-muted hover:text-oct-accent'}`}
              >
                {locked ? <Lock size={18} /> : <Unlock size={18} />}
              </button>
            </Tip>
          )}
          {!isPopout && !isWorkspace && paneCount < MAX_PANES && (
            <Tip label="Add chat pane">
              <button
                onClick={() => addPane()}
                className="p-1 text-oct-muted hover:text-oct-accent transition-colors duration-100"
              >
                <Plus size={18} />
              </button>
            </Tip>
          )}
          {paneCount > 1 && !isWorkspace && (
            <Tip label="Close pane">
              <button
                onClick={() => removePane(paneIndex)}
                className="p-1 text-oct-muted hover:text-oct-flame transition-colors duration-100"
              >
                <X size={18} />
              </button>
            </Tip>
          )}
        </div>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="px-2 sm:px-4 py-2 border-b-2 border-oct-border bg-oct-surface shrink-0 flex items-center gap-2">
          <Search size={16} className="text-oct-muted shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setActiveMatchIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) jumpToMatch(activeMatchIndex - 1);
                else jumpToMatch(activeMatchIndex + 1);
              }
              if (e.key === 'Escape') closeSearch();
            }}
            placeholder="Search messages..."
            className="flex-1 px-3 py-1.5 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
            autoFocus
          />
          {trimmedSearch && searchResults && (
            <div className="flex items-center gap-1 shrink-0">
              <span className="font-mono text-[10px] uppercase tracking-wide text-oct-muted tabular-nums">
                {searchResults.length === 0
                  ? 'No results'
                  : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`}
              </span>
              {searchResults.length > 1 && (
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
            onClick={closeSearch}
            className="p-0.5 text-oct-muted hover:text-oct-accent transition-colors duration-100 shrink-0"
            title="Close search (Esc)"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Hidden users panel */}
      {hiddenPanelOpen && channelHiddenUsers.length > 0 && (
        <div className="border-b-2 border-oct-border bg-oct-surface px-3 sm:px-4 py-3 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-oct-muted">
              Hidden Users
            </span>
            <button
              onClick={() => setHiddenPanelOpen(false)}
              className="text-oct-muted hover:text-oct-accent transition-colors duration-100"
            >
              <X size={14} />
            </button>
          </div>
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {channelHiddenUsers.map((entry) => (
              <div
                key={`${entry.guildId}:${entry.channelId}:${entry.userId}`}
                className="flex items-center justify-between gap-2 px-2 sm:px-2.5 py-1.5 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised"
              >
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <EyeOff size={12} className="shrink-0 text-oct-flame/70" />
                  <span className="text-sm text-oct-text font-medium truncate">{entry.displayName}</span>
                  <span className="text-[10px] text-oct-muted font-mono hidden sm:inline">{entry.userId}</span>
                  <span className="font-mono text-[10px] text-oct-muted truncate hidden sm:inline">
                    {entry.guildName ? `${entry.guildName} / ` : ''}#{entry.channelName}
                  </span>
                </div>
                <button
                  onClick={() => unhideUser(entry.guildId, entry.channelId, entry.userId)}
                  className="shrink-0 text-oct-muted hover:text-oct-flame transition-colors duration-100"
                  title="Unhide user"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
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

      {/* New-messages pill (shown while viewing older messages) */}
      {newMessageCount > 0 && !searchOpen && (
        <button
          onClick={jumpToPresent}
          className={`absolute ${chromeOwnsHeader ? 'top-9' : 'top-12'} left-0 right-0 z-20 flex items-center justify-between gap-2 px-3 sm:px-4 py-1.5 border-b-2 border-oct-border bg-oct-accent hover:bg-oct-accent-hover text-white font-mono text-[10px] sm:text-xs font-bold uppercase tracking-wide transition-colors duration-100`}
        >
          <span className="truncate">
            {newMessageCount} new message{newMessageCount !== 1 ? 's' : ''}
            {firstNewMessage ? ` since ${formatTime(firstNewMessage.timestamp)}` : ''}
          </span>
          <span className="flex items-center gap-1 shrink-0">Jump <ArrowDown size={14} /></span>
        </button>
      )}

      {/* "Viewing older messages" banner (replaces the plain jump button) */}
      {viewingOlder && !searchOpen && roomMessages.length > 0 && (
        <div
          className={`absolute ${chattingEnabled ? 'bottom-16' : 'bottom-4'} left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 rounded-cockpit border-2 border-oct-border-bright bg-oct-surface`}
        >
          <span className="font-mono text-[10px] sm:text-xs uppercase tracking-wide text-oct-muted whitespace-nowrap">You're viewing older messages</span>
          <button
            onClick={jumpToPresent}
            className="brutal-btn inline-flex items-center gap-1 px-2.5 py-1 text-[10px] sm:text-xs whitespace-nowrap"
          >
            Jump To Present <ArrowDown size={14} />
          </button>
        </div>
      )}

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
