import { useEffect, useMemo } from 'react';
import { MessageSquare, KeyRound } from 'lucide-react';
import { useAuthSession } from '../hooks/useAuthSession';
import { useAppStore } from '../stores/appStore';
import ChatView from '../components/ChatView';
import TokenSetup from '../components/TokenSetup';
import GatewayAuthBanner from '../components/GatewayAuthBanner';
import FeedChrome from '../components/feed/FeedChrome';
import { FEED_PRESET_DENSITY, FeedChromeContext, chromeOwnsPaneHeader, normalizeFeedChromePreset } from '../components/feed/feedChromeContract';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import FullPageSpinner from '../components/common/FullPageSpinner';
import PreviewBanner from '../components/preview/PreviewBanner';
import FirstRunGuide from '../components/preview/FirstRunGuide';
import { routes } from '../lib/routes';

export default function FeedPage() {
  const { isAuthenticated, ready } = useAuthSession();
  const authStatus = useAppStore((s) => s.authStatus);
  const authLoading = useAppStore((s) => s.authLoading);
  const previewMode = useAppStore((s) => s.previewMode);
  const previewSeeded = useAppStore((s) => s.previewSeeded);
  const rooms = useAppStore((s) => s.rooms);
  const paneRoomIds = useAppStore((s) => s.paneRoomIds);
  const setActiveRoom = useAppStore((s) => s.setActiveRoom);
  // The persisted pick (Settings > General or the in-feed switcher). Before
  // this read landed the Feed always wore the default preset and the setting
  // was write-only.
  const preset = useAppStore((s) => normalizeFeedChromePreset(s.config?.feedChromePreset));

  const discordConnected = authStatus?.configured || previewMode;

  useEffect(() => {
    if (!discordConnected || rooms.length === 0) return;
    if (paneRoomIds.length === 0) {
      setActiveRoom(rooms[0].id);
    }
  }, [discordConnected, rooms, paneRoomIds.length, setActiveRoom]);

  const chromeContext = useMemo(
    () => ({
      preset,
      ownsPaneHeader: chromeOwnsPaneHeader(preset, paneRoomIds.length),
      density: FEED_PRESET_DENSITY[preset],
    }),
    [preset, paneRoomIds.length],
  );

  if (!ready || (isAuthenticated && authLoading)) {
    return <FullPageSpinner />;
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
        <div className="relative overflow-hidden bg-gradient-to-br from-oct-flame to-oct-accent text-black px-6 sm:px-10 py-8 border-b border-oct-border shadow-oct-soft">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] mb-3 opacity-80">[ Feed ]</p>
          <h2 className="font-display text-3xl sm:text-4xl tracking-tight">Connect Discord</h2>
          <p className="font-mono text-xs sm:text-sm mt-3 max-w-lg text-black/90 leading-relaxed">
            Paste your token below to start streaming. Connection happens here in your browser — not at login.
          </p>
        </div>
        <div className="max-w-md mx-auto px-6 py-10">
          <div className="oct-card p-6">
            <div className="flex items-center gap-2 mb-6">
              <KeyRound size={18} className="text-oct-accent-2" />
              <span className="oct-eyebrow">Token setup</span>
            </div>
            <TokenSetup embedded />
          </div>
        </div>
      </div>
    );
  }

  // Connected for real but no room yet: guide the user instead of a blank feed.
  const showFirstRun = !previewSeeded && rooms.length === 0;

  return (
    <FeedChromeContext.Provider value={chromeContext}>
      <div className="flex flex-col h-full w-full min-h-0 bg-oct-bg">
        <PreviewBanner />
        {showFirstRun ? (
          <FirstRunGuide />
        ) : (
          <>
            <FeedChrome preset={chromeContext.preset} />
            <div className="flex flex-1 min-h-0 w-full">
              <ChatView standalone />
              <GatewayAuthBanner />
            </div>
          </>
        )}
      </div>
    </FeedChromeContext.Provider>
  );
}
