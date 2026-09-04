import { useAppStore } from '../../stores/appStore';
import { docsUrl } from '../../lib/links';
import SurfaceEmptyState from './SurfaceEmptyState';

// Feed with a live source but no room. The token/session form is the "no
// source" state and is a form, not an empty state, so it stays where it is
// (FeedPage renders TokenSetup). This is the step after it — and the single
// biggest activation leak: connected, then stalled with nothing to stream.
export default function FeedEmptyState() {
  const openConfigModal = useAppStore((s) => s.openConfigModal);

  return (
    <SurfaceEmptyState
      eyebrow="[ FEED ]"
      title="Source connected. No room yet."
      body="A room is a set of channels streamed into one pane. Pick channels from the servers you are already in and calls from them land here the moment they post."
      primary={{ label: 'Create a room', onClick: () => openConfigModal() }}
      secondary={{ label: 'How rooms work', href: docsUrl('feed/rooms') }}
    />
  );
}
