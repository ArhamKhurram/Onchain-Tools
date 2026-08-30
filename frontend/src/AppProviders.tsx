import { lazy, Suspense, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useClientGateway } from './hooks/useClientGateway';
import { useSignalConvergence } from './hooks/useSignalConvergence';
import { usePreviewFeed } from './preview/usePreviewFeed';
import { useAppStore } from './stores/appStore';
import { isHostedMode } from './lib/supabase';
import { useAuthSession } from './hooks/useAuthSession';
import { setTokenStateUserId } from './utils/tokenState';
import { identifyUser, resetAnalytics } from './lib/analytics';
import AlertToast from './components/AlertToast';

// Lazy: the room-config modal (plus its Channels/Users/Filter/Keywords tabs,
// BulkAddUsers and KeywordEditor — ~70 kB) renders null until it is opened.
// A static import kept all of it in the initial index chunk for every load.
const RoomConfig = lazy(() => import('./components/RoomConfig'));

/**
 * Mount the lazy modal only once it is actually opened (RoomConfig itself
 * returns null for the 'global' tab — GlobalSettings owns that). Gating on the
 * store flag here means the chunk isn't even fetched until first open.
 */
function RoomConfigGate() {
  const configModalOpen = useAppStore((s) => s.configModalOpen);
  const configModalTab = useAppStore((s) => s.configModalTab);
  if (!configModalOpen || configModalTab === 'global') return null;
  return (
    <Suspense fallback={null}>
      <RoomConfig />
    </Suspense>
  );
}

const MOBILE_BREAKPOINT = 768;

function useZoomScale() {
  const zoomScale = useAppStore((s) => s.config?.mobileZoomScale ?? 1);

  useEffect(() => {
    const isMobile = window.innerWidth < MOBILE_BREAKPOINT || 'ontouchstart' in window;
    if (!isMobile || zoomScale === 1) {
      document.documentElement.style.zoom = '';
      return;
    }
    document.documentElement.style.zoom = String(zoomScale);
    return () => { document.documentElement.style.zoom = ''; };
  }, [zoomScale]);
}

/** Shared providers: WebSocket, auth-adjacent data loading, toasts. */
export default function AppProviders({ children }: { children: React.ReactNode }) {
  useWebSocket();
  useClientGateway();
  useSignalConvergence();
  usePreviewFeed();
  useZoomScale();

  const { ready, userId, isAuthenticated } = useAuthSession();
  const authStatus = useAppStore((s) => s.authStatus);
  const checkAuth = useAppStore((s) => s.checkAuth);
  const fetchRooms = useAppStore((s) => s.fetchRooms);
  const fetchHistory = useAppStore((s) => s.fetchHistory);
  const fetchConfig = useAppStore((s) => s.fetchConfig);
  const fetchDMChannels = useAppStore((s) => s.fetchDMChannels);
  const fetchContracts = useAppStore((s) => s.fetchContracts);
  const loadFomoTradeHistory = useAppStore((s) => s.loadFomoTradeHistory);
  const previewMode = useAppStore((s) => s.previewMode);
  const previewSeeded = useAppStore((s) => s.previewSeeded);
  const rooms = useAppStore((s) => s.rooms);
  const setActiveRoom = useAppStore((s) => s.setActiveRoom);
  const dockPopout = useAppStore((s) => s.dockPopout);

  useEffect(() => {
    return window.oct?.onPopoutClosed((roomId) => dockPopout(roomId));
  }, [dockPopout]);

  useEffect(() => {
    setTokenStateUserId(userId);
    // Tie analytics to the Supabase UUID once a session resolves; clear it on
    // sign-out so the next user on this browser starts a fresh identity.
    if (userId) identifyUser(userId);
    else resetAnalytics();
  }, [userId]);

  useEffect(() => {
    if (!ready) return;
    if (isHostedMode && !isAuthenticated) {
      useAppStore.setState({ authLoading: false });
      return;
    }
    checkAuth();
  }, [ready, isAuthenticated, checkAuth]);

  useEffect(() => {
    // Seeded preview supplies its own rooms/config/history in-memory; hitting the
    // backend here would overwrite the sample feed with an empty account.
    if (previewSeeded) return;
    if (authStatus?.configured || previewMode) {
      fetchRooms();
      fetchConfig();
      fetchDMChannels();
      fetchHistory();
    }
  }, [authStatus?.configured, previewMode, previewSeeded, fetchRooms, fetchHistory, fetchConfig, fetchDMChannels]);

  useEffect(() => {
    if (previewSeeded) return; // sample contracts are already seeded in-memory
    if (!ready) return;
    if (isHostedMode && !isAuthenticated) return;
    if (authStatus?.configured || previewMode || isAuthenticated) {
      fetchContracts();
      // Replay the last 24h so the FOMO feed isn't empty on every reload; live
      // WS frames merge in on top. No-ops without FOMO storage configured.
      void loadFomoTradeHistory();
    }
  }, [ready, isAuthenticated, authStatus?.configured, previewMode, previewSeeded, fetchContracts, loadFomoTradeHistory]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key.length !== 1) return;
      const key = e.key.toLowerCase();
      const room = rooms.find((r) => r.hotkey && r.hotkey.toLowerCase() === key);
      if (room) {
        e.preventDefault();
        setActiveRoom(room.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rooms, setActiveRoom]);

  if (isHostedMode && !ready) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-oct-bg">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      {children}
      <AlertToast />
      <RoomConfigGate />
    </>
  );
}
