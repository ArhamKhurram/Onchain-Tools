// Product analytics — the ONE place PostHog is touched.
//
// Why it exists: OCT was flying blind (~62 signups, no idea where they drop).
// This measures the activation funnel — sign in → connect Discord → create a
// room → set up a signal — so we can see and fix the leak.
//
// PRIVACY POSTURE (deliberate, and part of OCT's whole "honest tool" pitch):
//   - No autocapture. The DOM is full of wallet addresses, contract addresses
//     and caller handles; autocapture would hoover them up via element text and
//     selectors. We send ONLY named events we write by hand.
//   - No session recording, ever. Same reason.
//   - `mask_all_text` on, as defense in depth for anything PostHog captures.
//   - The distinct id is the Supabase user UUID — an opaque id the app already
//     uses as identity. We never send email, wallet, token, or CA as a property.
//   - Respects Do-Not-Track.
//
// It is a NO-OP unless VITE_POSTHOG_KEY is set, so local dev and any deploy
// without the key send nothing. The key is PostHog's *project* API key
// (starts `phc_`), which is public by design — safe to ship in the bundle.

import posthog from 'posthog-js';

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';

let started = false;

/** True once PostHog is actually running (key present + init done). */
function live(): boolean {
  return started && !!KEY;
}

/**
 * Boot PostHog once, early. No-op without a key. Safe to call before render —
 * mirrors initTheme() in main.tsx.
 */
export function initAnalytics(): void {
  if (started || !KEY) return;
  started = true;
  posthog.init(KEY, {
    api_host: HOST,
    autocapture: false, // never scrape the DOM — wallets/CAs live there
    capture_pageview: false, // SPA: we send app_opened + explicit events instead
    disable_session_recording: true, // never record a screen full of holdings
    mask_all_text: true,
    persistence: 'localStorage',
    respect_dnt: true,
    // Keep PostHog from auto-identifying via anything but our explicit id.
    person_profiles: 'identified_only',
  });
  track('app_opened');
}

/**
 * Tie subsequent events to a user. `userId` is the Supabase UUID — opaque, not
 * PII. Call when a session resolves; call `resetAnalytics()` on sign-out.
 */
export function identifyUser(userId: string): void {
  if (!live() || !userId) return;
  posthog.identify(userId);
}

/** Clear identity on sign-out so the next user isn't merged into this one. */
export function resetAnalytics(): void {
  if (!live()) return;
  posthog.reset();
}

/**
 * Record a named event. Props are optional and must never carry a secret or a
 * user-identifying on-chain value (wallet, token, CA). Counts and enums only.
 */
export function track(event: string, props?: Record<string, string | number | boolean>): void {
  if (!live()) return;
  posthog.capture(event, props);
}
