import type { StateCreator } from 'zustand';
import type { RevivalAlertData } from '../../types';
import type { AppState } from '../appStore';
import { playRevivalSound } from '../../utils/notificationSound';

/**
 * Active revival ignition banners. Deliberately NOT auto-dismissed: a revival
 * is the loudest alert class in the app and stays on screen (with a repeating
 * sound) until the user explicitly dismisses it. Notification history is
 * handled separately via addAlert in useWebSocket — this slice only owns the
 * live banners + their sound loops.
 *
 * Revival is its own independent signal; it never merges with convergence,
 * missed-runner, or FOMO state.
 */

export interface ActiveRevival extends RevivalAlertData {
  id: string;
}

const REPEAT_INTERVAL_MS = 5_000;
const MAX_REPEATS = 12;

// Sound-loop bookkeeping lives outside the store: timers are transient
// side-effect state, not something any component renders.
const soundLoops = new Map<string, ReturnType<typeof setInterval>>();

function stopSoundLoop(id: string): void {
  const timer = soundLoops.get(id);
  if (timer != null) {
    clearInterval(timer);
    soundLoops.delete(id);
  }
}

function startSoundLoop(id: string, getState: () => AppState): void {
  stopSoundLoop(id);
  const cfg = getState().config;
  const sc = cfg?.soundSettings?.revival;
  if (cfg && !cfg.messageSounds) return;
  if (sc && !sc.enabled) return;

  playRevivalSound(sc);
  // Repeat-until-dismissed defaults ON for revival; an explicit false disables.
  if (sc?.repeatUntilDismissed === false) return;

  let repeats = 0;
  const timer = setInterval(() => {
    repeats += 1;
    if (repeats > MAX_REPEATS) {
      stopSoundLoop(id);
      return;
    }
    // Stop when the banner is gone (dismissed through any path).
    const stillActive = getState().activeRevivals.some((r) => r.id === id);
    if (!stillActive) {
      stopSoundLoop(id);
      return;
    }
    playRevivalSound(getState().config?.soundSettings?.revival);
  }, REPEAT_INTERVAL_MS);
  soundLoops.set(id, timer);
}

export interface RevivalSlice {
  activeRevivals: ActiveRevival[];

  /** Add (or refresh, keyed by mint) a live revival banner + start its sound loop. */
  addRevival: (data: RevivalAlertData, options?: { silent?: boolean }) => void;
  /** Explicit user dismissal — removes the banner and stops the sound loop. */
  dismissRevival: (id: string) => void;
}

export const createRevivalSlice: StateCreator<AppState, [], [], RevivalSlice> = (set, get) => ({
  activeRevivals: [],

  addRevival: (data, options) => {
    const id = `revival-${data.mint}`;
    set((state) => {
      // Re-ignition of a mint that is still on screen replaces the old banner
      // (fresh numbers) rather than stacking a duplicate.
      const rest = state.activeRevivals.filter((r) => r.id !== id);
      return { activeRevivals: [{ ...data, id }, ...rest] };
    });
    if (!options?.silent) {
      startSoundLoop(id, get);
    }
  },

  dismissRevival: (id) => {
    stopSoundLoop(id);
    set((state) => ({
      activeRevivals: state.activeRevivals.filter((r) => r.id !== id),
    }));
  },
});
