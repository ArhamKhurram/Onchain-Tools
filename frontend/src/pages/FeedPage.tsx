import { useEffect } from 'react';
import { MessageSquare, KeyRound } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useAppStore } from '../stores/appStore';
import ChatView from '../components/ChatView';
import RoomConfig from '../components/RoomConfig';
import TokenSetup from '../components/TokenSetup';
import GatewayAuthBanner from '../components/GatewayAuthBanner';
import FeedToolbar from '../components/feed/FeedToolbar';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import { routes } from '../lib/routes';

export default function FeedPage() {
  const { isAuthenticated, ready } = useAuthSession();
  const authStatus = useAppStore((s) => s.authStatus);
  const authLoading = useAppStore((s) => s.authLoading);
  const previewMode = useAppStore((s) => s.previewMode);
  const rooms = useAppStore((s) => s.rooms);
  const paneRoomIds = useAppStore((s) => s.paneRoomIds);
  const setActiveRoom = useAppStore((s) => s.setActiveRoom);

  const discordConnected = authStatus?.configured || previewMode;

  useEffect(() => {
    if (!discordConnected || rooms.length === 0) return;
    if (paneRoomIds.length === 0) {
      setActiveRoom(rooms[0].id);
    }
  }, [discordConnected, rooms, paneRoomIds.length, setActiveRoom]);

  if (!ready || (isAuthenticated && authLoading)) {
    return (
      <div className="flex items-center justify-center h-full bg-oct-bg">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={MessageSquare}
        eyebrow="[ FEED ]"
        title="Sign in to stream"
        description="Live chat requires an OCT account. Your Discord token stays in this browser — rooms and settings sync to your account."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  if (!discordConnected) {
    return (
      <div className="h-full overflow-y-auto bg-oct-bg">
        <div className="bg-oct-flame text-black px-6 sm:px-10 py-8 border-b-2 border-black">
          <p className="font-mono text-xs tracking-[0.2em] mb-3">[ FEED ]</p>
          <h2 className="font-display text-3xl sm:text-4xl tracking-tight">Connect Discord</h2>
          <p className="font-mono text-xs sm:text-sm mt-3 max-w-lg text-black/90 leading-relaxed">
            Paste your token below to start streaming. Connection happens here in your browser — not at login.
          </p>
        </div>
        <div className="max-w-md mx-auto px-6 py-10">
          <div className="flex items-center gap-2 mb-6">
            <KeyRound size={18} className="text-oct-accent" />
            <span className="font-mono text-xs uppercase tracking-[0.15em] text-oct-muted">Token setup</span>
          </div>
          <TokenSetup embedded />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full min-h-0 bg-oct-bg">
      <FeedToolbar />
      <div className="flex flex-1 min-h-0 w-full">
        <ChatView standalone />
        <RoomConfig />
        <GatewayAuthBanner />
      </div>
    </div>
  );
}
