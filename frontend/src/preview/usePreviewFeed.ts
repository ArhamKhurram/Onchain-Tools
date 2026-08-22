import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { nextPreviewStreamEvent } from './previewFeed';
import { track } from '../lib/analytics';

// Drives the seeded preview feed: while `previewSeeded` is on, push a new
// message (sometimes carrying a fresh contract) every few seconds so a new user
// watches calls scroll in live — the onboarding "aha" — before connecting.
const STREAM_INTERVAL_MS = 3500;

export function usePreviewFeed(): void {
  const previewSeeded = useAppStore((s) => s.previewSeeded);

  useEffect(() => {
    if (!previewSeeded) return;

    const { addMessage, addContract } = useAppStore.getState();

    // The seed already puts enriched CA rows on screen the instant preview opens,
    // so the "aha" (a contract rendered in the demo) has happened by now.
    track('preview_ca_seen');

    const tick = () => {
      const { message, roomIds, contract } = nextPreviewStreamEvent();
      addMessage(message, roomIds, true);
      if (contract) {
        addContract(contract, { skipCatalogHydrate: true });
      }
    };

    const id = window.setInterval(tick, STREAM_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [previewSeeded]);
}
