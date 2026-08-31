// JWT expiry watch.
//
// j7 has no refresh flow OCT can drive: a human clears a Cloudflare Turnstile,
// copies the resulting 15-day token into J7_JWTS_JSON and restarts. So the
// failure mode is not "auth broke", it is "nobody remembered" — and its symptom
// is a socket the server closes with `io server disconnect`, i.e. the entire
// callout + trade feed silently stopping. This module's whole job is to make
// that predictable: say so days ahead, out loud, more than once.
//
// The token is DECODED, never verified. We hold no signing key and do not need
// one — `exp` is a claim we read to schedule a human, not an authorisation
// decision. And the token itself is never logged: only the account label and the
// expiry date.

import type { J7Account } from './client.js';

/** Warn once a token is inside this many days of expiring. */
const WARN_DAYS = Number.parseInt(process.env.J7_JWT_WARN_DAYS ?? '', 10) || 3;
const DAY_MS = 86_400_000;
/** Re-check (and re-warn) daily — one nag per day, not one per boot. */
const CHECK_INTERVAL_MS = Number.parseInt(process.env.J7_JWT_CHECK_INTERVAL_MS ?? '', 10) || DAY_MS;

/**
 * The `exp` claim as epoch ms, or null when the token is malformed / has no
 * numeric `exp`.
 *
 * Pure and total: every failure mode (wrong segment count, non-base64url middle,
 * non-JSON payload, missing or non-numeric `exp`) returns null rather than
 * throwing, because a malformed token must not take the boot path down — the
 * socket layer will surface the real problem when the server rejects it.
 */
export function decodeJwtExpiry(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== 'object' || payload === null) return null;
    const exp = (payload as Record<string, unknown>).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

/** One account's credential status at a point in time. */
export interface JwtStatus {
  username: string;
  /** Epoch ms, or null when the token could not be decoded. */
  expiresAt: number | null;
  /** Negative once expired. Null when `expiresAt` is null. */
  daysLeft: number | null;
  expired: boolean;
  /** True when it is expired or inside the warning window. */
  needsAttention: boolean;
}

/** Classify one account's JWT against `now`. Pure. */
export function inspectJwt(account: J7Account, now: number): JwtStatus {
  const expiresAt = decodeJwtExpiry(account.jwt);
  if (expiresAt === null) {
    // Undecodable is not "fine": we cannot promise it will last, so it is
    // surfaced too — just without a date.
    return { username: account.username, expiresAt: null, daysLeft: null, expired: false, needsAttention: true };
  }
  const daysLeft = (expiresAt - now) / DAY_MS;
  return {
    username: account.username,
    expiresAt,
    daysLeft,
    expired: daysLeft <= 0,
    needsAttention: daysLeft < WARN_DAYS,
  };
}

/** The operator-facing line: which account, when, and what a human must do. */
export function describeJwtStatus(status: JwtStatus): string {
  const who = `j7 account "${status.username}"`;
  const fix = 'a human must re-login through the Turnstile and update J7_JWTS_JSON (then restart)';
  if (status.expiresAt === null) {
    return `${who}: JWT could not be decoded (no readable exp) — ${fix}.`;
  }
  const when = new Date(status.expiresAt).toISOString();
  if (status.expired) return `${who}: JWT EXPIRED ${when} — the feed is down until ${fix}.`;
  const days = (status.daysLeft ?? 0).toFixed(1);
  return `${who}: JWT expires ${when} (in ${days} days) — ${fix}.`;
}

/** Where a warning goes beyond the log. Injected so tests stay offline. */
export interface JwtWatchDeps {
  notify(message: string): Promise<void>;
}

let _timer: NodeJS.Timeout | null = null;

/**
 * Check every configured JWT now, then once a day.
 *
 * Delivery is console.error PLUS a best-effort push to the operator (see
 * index.ts for how that recipient is resolved). The log line is the guarantee —
 * the push is the thing that reaches someone who is not watching logs — so the
 * notifier failing never suppresses the warning.
 */
export function startJ7JwtWatch(accounts: J7Account[], deps: JwtWatchDeps): void {
  if (_timer) return;

  const check = (): void => {
    for (const account of accounts) {
      const status = inspectJwt(account, Date.now());
      if (!status.needsAttention) continue;
      const line = describeJwtStatus(status);
      console.error(`[J7] ${line}`);
      void deps.notify(line).catch((err) =>
        console.error('[J7] JWT expiry notify failed:', (err as Error)?.message),
      );
    }
  };

  check();
  _timer = setInterval(check, CHECK_INTERVAL_MS);
}

/** Stop the daily check (clean shutdown / tests). */
export function stopJ7JwtWatch(): void {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
