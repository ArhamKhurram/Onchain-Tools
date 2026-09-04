// The activation model — pure, store-free, unit-tested.
//
// Why this exists: ~80% of signups never activate. The console is empty until a
// source is connected AND a room exists AND something is being watched, and a
// new user was left to discover those three dependencies one blank screen at a
// time. Everything that decides "what does this user still need to do" lives
// here so the Dashboard checklist and every per-surface empty state agree on
// the answer — the empty state on Callers says "create a room" for exactly the
// same reason the checklist's second step is unticked.
//
// Inputs are plain counts and booleans so the module has no opinion about where
// they come from (appStore in both modes; Supabase-direct wallet hooks in hosted).

import { routes } from './routes';

export interface ActivationInput {
  /** Discord token present (local: on the server; hosted: in this browser). */
  discordConfigured: boolean;
  /** Telegram session present. */
  telegramConfigured: boolean;
  roomCount: number;
  /**
   * Highlighted callers across every room plus the global list. A caller is
   * the only "watch" target that exists in BOTH modes — tracked wallets are a
   * Supabase table, so in local mode they are always zero.
   */
  watchedCallerCount: number;
  trackedWalletCount: number;
  holdingWalletCount: number;
  /** Contracts detected this session — the first real signal. */
  contractCount: number;
  /** `isHostedMode` — swaps copy and the deep-link for the watch step. */
  hosted: boolean;
}

export type ActivationStepId = 'connect' | 'room' | 'watch' | 'signal';

export interface ActivationStep {
  id: ActivationStepId;
  label: string;
  /** One line under the label: what the step unlocks, not how to do it. */
  detail: string;
  done: boolean;
  /**
   * Where the step is completed. A `routes` value; the checklist turns it into
   * a router Link. The `room` step in addition opens the room-config modal,
   * which the checklist handles itself — the path is still Feed so the modal
   * closes onto the surface it feeds.
   */
  to: string;
}

/** Any source connected. What the "surfaced for users with no sources" gate keys on. */
export function hasSource(input: Pick<ActivationInput, 'discordConfigured' | 'telegramConfigured'>): boolean {
  return input.discordConfigured || input.telegramConfigured;
}

export function isWatchingSomething(
  input: Pick<ActivationInput, 'watchedCallerCount' | 'trackedWalletCount' | 'holdingWalletCount'>,
): boolean {
  return input.watchedCallerCount > 0 || input.trackedWalletCount > 0 || input.holdingWalletCount > 0;
}

/**
 * The four steps, in dependency order. Always all four: a step the user has
 * already done renders ticked rather than vanishing, so the list reads as
 * progress instead of a shrinking pile of chores.
 */
export function buildActivationSteps(input: ActivationInput): ActivationStep[] {
  const connected = hasSource(input);
  return [
    {
      id: 'connect',
      label: input.hosted ? 'Connect Discord or Telegram' : 'Add a Discord token or Telegram session',
      detail: input.hosted
        ? 'Your token stays in this browser. Nothing streams until a source is live.'
        : 'Stored in backend/data. Nothing streams until a source is live.',
      done: connected,
      to: routes.feed,
    },
    {
      id: 'room',
      label: 'Create a room',
      detail: 'Pick channels from servers you are already in. Calls from those channels land in Feed.',
      done: input.roomCount > 0,
      to: routes.feed,
    },
    {
      id: 'watch',
      label: input.hosted ? 'Watch a caller or wallet' : 'Highlight a caller',
      detail: input.hosted
        ? 'Highlight a caller in a room, or add an on-chain address to the Directory.'
        : 'Highlight a caller in a room so their calls stand out and alert.',
      done: isWatchingSomething(input),
      // Local mode has no Directory (it is a Supabase table), so the only
      // watch target is a highlighted caller — which lives in room config.
      to: input.hosted ? routes.directory : routes.feed,
    },
    {
      id: 'signal',
      label: 'First contract detected',
      detail: 'Happens on its own once a watched room posts a CA. Lands in Callers.',
      done: input.contractCount > 0,
      to: routes.callers,
    },
  ];
}

export function countDone(steps: ActivationStep[]): number {
  return steps.filter((s) => s.done).length;
}

/** The first unticked step — what the checklist points at. */
export function nextStep(steps: ActivationStep[]): ActivationStep | null {
  return steps.find((s) => !s.done) ?? null;
}

/**
 * Whether the checklist should still be on screen. It stays until every step
 * is ticked, not just until a source connects: connect-then-stall (a token but
 * no room) is the single largest leak, and hiding the list at "connected" would
 * drop the user at exactly that point.
 */
export function needsActivation(input: ActivationInput): boolean {
  return countDone(buildActivationSteps(input)) < 4;
}

// ── Per-surface "why is this empty" ──────────────────────────────────────────
//
// Callers (Contracts + Radar) are downstream of Feed: they cannot be made
// non-empty on their own page. Their ONE primary action is therefore whichever
// upstream step is missing, resolved here so both tabs and the checklist agree.

export type UpstreamGap = 'source' | 'room' | 'none';

export function upstreamGap(input: Pick<ActivationInput, 'discordConfigured' | 'telegramConfigured' | 'roomCount'>): UpstreamGap {
  if (!hasSource(input)) return 'source';
  if (input.roomCount === 0) return 'room';
  return 'none';
}

/**
 * Cheap, stable identifiers stored in `seenAnnouncements` (and the matching
 * localStorage list) when the checklist is dismissed. Versioned so a future
 * rework can re-surface the list without touching persistence.
 */
export const ACTIVATION_CHECKLIST_DISMISS_ID = 'onboarding-checklist-v1';
