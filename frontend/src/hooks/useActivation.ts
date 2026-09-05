import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { isHostedMode } from '../lib/supabase';
import {
  buildActivationSteps,
  upstreamGap,
  type ActivationInput,
  type ActivationStep,
  type UpstreamGap,
} from '../lib/activation';

// Reads the activation inputs that live in appStore — everything except the
// two Supabase wallet tables, which are per-page hooks (useTrackedWallets /
// useHoldingWallets) and are passed in by the one caller that mounts them.
//
// Every value is selected individually so a WebSocket frame that appends a
// message does not re-render an empty state; only the handful of counts and
// booleans below can trigger one.

export interface ActivationCounts {
  trackedWalletCount?: number;
  holdingWalletCount?: number;
}

export function useActivationInput(counts: ActivationCounts = {}): ActivationInput {
  const authStatus = useAppStore((s) => s.authStatus);
  const previewMode = useAppStore((s) => s.previewMode);
  const rooms = useAppStore((s) => s.rooms);
  const globalHighlighted = useAppStore((s) => s.config?.globalHighlightedUsers);
  const contractCount = useAppStore((s) => s.contracts.length);

  const watchedCallerCount = useMemo(
    () =>
      rooms.reduce((n, r) => n + (r.highlightedUsers?.length ?? 0), 0) +
      (globalHighlighted?.length ?? 0),
    [rooms, globalHighlighted],
  );

  // Preview mode is the seeded demo feed; it renders rooms and CAs without a
  // token, so for activation purposes it is "not yet connected" — the whole
  // point of the checklist is to move the user off it.
  const discordConfigured = !previewMode && (authStatus?.configured ?? false);
  const telegramConfigured = !previewMode && (authStatus?.telegramConfigured ?? false);
  const roomCount = previewMode ? 0 : rooms.length;
  const watched = previewMode ? 0 : watchedCallerCount;
  const trackedWalletCount = counts.trackedWalletCount ?? 0;
  const holdingWalletCount = counts.holdingWalletCount ?? 0;
  const contracts = previewMode ? 0 : contractCount;

  // Memoised on the primitives so consumers can key their own memos on the
  // object identity instead of re-deriving the step list every render.
  return useMemo<ActivationInput>(
    () => ({
      discordConfigured,
      telegramConfigured,
      roomCount,
      watchedCallerCount: watched,
      trackedWalletCount,
      holdingWalletCount,
      contractCount: contracts,
      hosted: isHostedMode,
    }),
    [discordConfigured, telegramConfigured, roomCount, watched, trackedWalletCount, holdingWalletCount, contracts],
  );
}

export function useActivationSteps(counts?: ActivationCounts): ActivationStep[] {
  const input = useActivationInput(counts);
  return useMemo(() => buildActivationSteps(input), [input]);
}

/** What a downstream surface (Contracts, Radar) is waiting on. */
export function useUpstreamGap(): UpstreamGap {
  const input = useActivationInput();
  return upstreamGap(input);
}
