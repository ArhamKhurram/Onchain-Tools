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

// posthog-js is imported DYNAMICALLY, not statically, and that is load-bearing:
// the library is ~85 kB gzipped, this module is the only thing that touches it,
// and it does nothing at all without a key. A static import put those bytes in
// the entry chunk of every single page load — paid on the critical path even in
// local dev and on any deploy where VITE_POSTHOG_KEY is unset. Fetching it from
// inside the key check moves it off the critical path, and lets the bundler drop
// it outright when the key is unset. Type-only import; erased at build.
import type { PostHog } from 'posthog-js';

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';

let started = false;
let client: PostHog | null = null;
let unavailable = false;

// Calls made after initAnalytics() but before the posthog-js chunk resolves.
// Deferring the import opens a window across first paint, and the session's most
// valuable events live in it — app_opened, the first $pageview, the sign-in
// identify. Queue them and replay in call order rather than dropping them.
// Bounded so a chunk that never loads cannot grow this without limit.
const pending: Array<(ph: PostHog) => void> = [];
const PENDING_MAX = 50;

/**
 * Run `fn` against the live client, queueing it if the chunk is still in
 * flight. No-op when analytics never started (no key, or before init) — the
 * same silence the old `live()` guard gave.
 */
function withPostHog(fn: (ph: PostHog) => void): void {
  if (!started || !KEY || unavailable) return;
  if (client) {
    fn(client);
    return;
  }
  if (pending.length < PENDING_MAX) pending.push(fn);
}

/**
 * Boot PostHog once, early. No-op without a key. Safe to call before render —
 * mirrors initTheme() in main.tsx. Returns immediately; the library loads and
 * initialises asynchronously, and events raised meanwhile are queued.
 */
export function initAnalytics(): void {
  if (started || !KEY) return;
  started = true;
  const key = KEY;
  void import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: HOST,
        autocapture: false, // never scrape the DOM — wallets/CAs live there
        // Pageviews ARE captured (traffic, top pages, referrers) but they only ever
        // carry a URL, never DOM content — and `sanitize_properties` scrubs the URL
        // first (query/hash dropped, address-like path segments masked). The truly
        // invasive channels (autocapture, session recording) stay off.
        capture_pageview: true,
        disable_session_recording: true, // never record a screen full of holdings
        mask_all_text: true,
        persistence: 'localStorage',
        respect_dnt: true,
        // Keep PostHog from auto-identifying via anything but our explicit id.
        person_profiles: 'identified_only',
        sanitize_properties: (properties) => {
          for (const key of URL_PROPERTY_KEYS) {
            const value = properties[key];
            if (typeof value === 'string') properties[key] = sanitizeUrl(value);
          }
          return properties;
        },
      });
      client = posthog;
      // Order is deliberate and matches the old synchronous path: init fires the
      // session's first $pageview, then app_opened, then whatever queued while
      // the chunk was loading (identify included, so app_opened stays anonymous
      // exactly as it was before).
      track('app_opened');
      for (const fn of pending.splice(0)) fn(posthog);
    })
    .catch(() => {
      // Analytics must never break the app. If the chunk can't load — offline,
      // blocked, a bad deploy — go quiet for the rest of the session instead of
      // queueing events nothing will ever drain.
      unavailable = true;
      pending.length = 0;
    });
}

// PostHog auto-props that carry a URL. We rewrite each so a wallet or contract
// address that ends up in the path/query never reaches PostHog.
const URL_PROPERTY_KEYS = [
  '$current_url',
  '$pathname',
  '$referrer',
  '$initial_current_url',
  '$initial_pathname',
  '$initial_referrer',
] as const;

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Strip the query/hash and mask any address-like path segment. A token detail
 * URL like `/dashboard/token/0xabc…/` becomes `/dashboard/token/:addr/` — we
 * learn which *pages* get traffic without recording which wallet or coin a
 * given user looked at.
 */
export function sanitizeUrl(raw: string): string {
  const noQuery = raw.split(/[?#]/)[0];
  return noQuery
    .split('/')
    .map((seg) => (EVM_ADDR.test(seg) || SOL_ADDR.test(seg) ? ':addr' : seg))
    .join('/');
}

/**
 * Tie subsequent events to a user. `userId` is the Supabase UUID — opaque, not
 * PII. Call when a session resolves; call `resetAnalytics()` on sign-out.
 */
export function identifyUser(userId: string): void {
  if (!userId) return;
  withPostHog((ph) => ph.identify(userId));
}

/** Clear identity on sign-out so the next user isn't merged into this one. */
export function resetAnalytics(): void {
  withPostHog((ph) => ph.reset());
}

/**
 * Record a named event. Props are optional and must never carry a secret or a
 * user-identifying on-chain value (wallet, token, CA). Counts and enums only.
 */
export function track(event: string, props?: Record<string, string | number | boolean>): void {
  withPostHog((ph) => ph.capture(event, props));
}
