import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, KeyRound } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useAppStore } from '../stores/appStore';
import ChatView from '../components/ChatView';
import RoomConfig from '../components/RoomConfig';
import TokenSetup from '../components/TokenSetup';
import GatewayAuthBanner from '../components/GatewayAuthBanner';
import FeedToolbar from '../components/feed/FeedToolbar';

export default function FeedPage() {
  const { isAuthenticated, ready } = useAuthSession();
  const authStatus = useAppStore((s) => s.authStatus);
  const authLoading = useAppStore((s) => s.authLoading);
  const previewMode = useAppStore((s) => s.previewMode);
  const rooms = useAppStore((s) => s.rooms);
  const paneRoomIds = useAppStore((s) => s.paneRoomIds);
  const setActiveRoom = useAppStore((s) => s.setActiveRoom);

  const discordConnected = authStatus?.configured || previewMode;

  // Auto-select first room when none is active (skip full-screen onboarding).
  useEffect(() => {
    if (!discordConnected || rooms.length === 0) return;
    if (paneRoomIds.length === 0) {
      setActiveRoom(rooms[0].id);
    }
  }, [discordConnected, rooms, paneRoomIds.length, setActiveRoom]);

  if (!ready || (isAuthenticated && authLoading)) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="max-w-md text-center">
          <div className="w-14 h-14 rounded-cockpit border-2 border-black bg-oct-accent shadow-oct-hard flex items-center justify-center mx-auto mb-5">
            <MessageSquare size={28} className="text-white" />
          </div>
          <h2 className="text-xl font-extrabold uppercase text-oct-text mb-2">Sign in to use Feed</h2>
          <p className="text-sm text-oct-muted mb-6 leading-relaxed">
            Live chat requires an OCT account so your rooms and Discord token are stored securely.
          </p>
          <Link
            to="/dashboard/login"
            className="brutal-btn inline-flex px-5 py-2.5 text-sm"
          >
            Sign in
          </Link>
          <p className="mt-4 text-xs text-oct-muted">
            <Link to="/dashboard" className="text-oct-accent hover:underline">Back to dashboard</Link>
          </p>
        </div>
      </div>
    );
  }

  if (!discordConnected) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-lg mx-auto pt-12 px-6 pb-8 text-center">
          <div className="w-14 h-14 rounded-cockpit border-2 border-black bg-oct-accent shadow-oct-hard flex items-center justify-center mx-auto mb-5">
            <KeyRound size={28} className="text-white" />
          </div>
          <h2 className="text-xl font-extrabold uppercase text-oct-text mb-2">Connect Discord</h2>
          <p className="text-sm text-oct-muted mb-8 leading-relaxed">
            Add your Discord token to start streaming channels. Connection happens here — not at login.
          </p>
        </div>
        <div className="max-w-md mx-auto px-6 pb-12">
          <TokenSetup embedded />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <FeedToolbar />
      <div className="flex flex-1 min-h-0 w-full">
        <ChatView standalone />
        <RoomConfig />
        <GatewayAuthBanner />
      </div>
    </div>
  );
}
