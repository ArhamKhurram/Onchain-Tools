// Validation for a caller-supplied FOMO identity on POST /api/fomo/tracked.
//
// WHY THIS EXISTS
// ---------------
// Tracking used to be resolve-then-write: the server turned free text into a
// real FOMO user through the shared service account, so the identity written to
// `fomo_tracked_users` was always the server's own. That account has been
// Forbidden upstream since 2026-08-26, which made every TRACK a 503 — including
// from the leaderboard, which already *holds* a resolved identity (the
// 985monitor snapshot rows carry uid / handle / name; see monitor985.ts).
//
// Letting the caller supply that identity fixes the button, and moves a value
// that used to be server-chosen into the request body. It is therefore
// UNTRUSTED INPUT that gets persisted, so it is narrowed here, hard:
//
//   * `fomoUserId` must be a v4-shaped UUID — that is what FOMO ids are, and
//     the column is the join key the poller and the fan-out read back.
//   * `fomoHandle` gets the same charset/length rule the robinhood routes use
//     for a handle path segment.
//   * `displayName` is length-capped and must carry no control characters, so
//     it cannot smuggle a newline into a log line.
//
// Everything REJECTS rather than coerces: a caller that sends a malformed
// identity gets a 400, not a silently truncated row. And there is deliberately
// no `userId` field here — the row's owner comes from `getUserId(req)` and is
// never readable from the body.
//
// Pure and unit-tested; the route only branches on the result.

import { isRecord } from '../utils/untrusted.js';

export interface SuppliedFomoIdentity {
  fomoUserId: string;
  fomoHandle: string | null;
  displayName: string | null;
}

export type SuppliedIdentityResult =
  /** No identity in the body — the caller wants the free-text resolve path. */
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; identity: SuppliedFomoIdentity };

/** FOMO user ids are UUIDs (e.g. 6d8c0bf3-5d42-506c-a0ea-9e1e75ff38af). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same rule the Robinhood trader route applies to a handle. */
const HANDLE_RE = /^[A-Za-z0-9_.-]+$/;
const HANDLE_MAX = 64;

const DISPLAY_NAME_MAX = 64;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

/**
 * Strip a value down to something safe to echo back in an error message. Not a
 * security control on its own — responses are JSON and React renders text — but
 * it keeps an attacker-chosen string from reaching a log line or an error body
 * at arbitrary length or with embedded newlines.
 */
export function sanitizeForEcho(value: string, maxLength = 64): string {
  const stripped = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

/**
 * Read an optional pre-resolved identity out of a POST /tracked body.
 *
 * Returns `none` when the caller supplied no `fomoUserId` at all — that is the
 * free-text path and stays exactly as it was (live client, or 503).
 */
export function parseSuppliedFomoIdentity(body: unknown): SuppliedIdentityResult {
  if (!isRecord(body)) return { kind: 'none' };

  const rawId = body.fomoUserId;
  if (rawId === undefined || rawId === null || (typeof rawId === 'string' && rawId.trim() === '')) {
    // No id supplied. Any handle/name sent alongside is meaningless without it
    // and is ignored rather than half-trusted.
    return { kind: 'none' };
  }

  if (typeof rawId !== 'string') {
    return { kind: 'invalid', error: 'fomoUserId must be a string.' };
  }
  const fomoUserId = rawId.trim();
  if (!UUID_RE.test(fomoUserId)) {
    return { kind: 'invalid', error: 'fomoUserId must be a UUID.' };
  }

  const handleResult = parseHandle(body.fomoHandle);
  if ('error' in handleResult) return { kind: 'invalid', error: handleResult.error };

  const nameResult = parseDisplayName(body.displayName);
  if ('error' in nameResult) return { kind: 'invalid', error: nameResult.error };

  return {
    kind: 'ok',
    identity: {
      fomoUserId: fomoUserId.toLowerCase(),
      fomoHandle: handleResult.value,
      displayName: nameResult.value,
    },
  };
}

function parseHandle(raw: unknown): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: 'fomoHandle must be a string.' };
  const handle = raw.trim().replace(/^@/, '');
  if (!handle) return { value: null };
  if (handle.length > HANDLE_MAX) {
    return { error: `fomoHandle must be ${HANDLE_MAX} characters or fewer.` };
  }
  if (!HANDLE_RE.test(handle)) {
    return { error: 'fomoHandle contains unsupported characters.' };
  }
  return { value: handle };
}

function parseDisplayName(raw: unknown): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: 'displayName must be a string.' };
  const name = raw.trim();
  if (!name) return { value: null };
  if (name.length > DISPLAY_NAME_MAX) {
    return { error: `displayName must be ${DISPLAY_NAME_MAX} characters or fewer.` };
  }
  if (CONTROL_CHARS_RE.test(name)) {
    return { error: 'displayName contains control characters.' };
  }
  return { value: name };
}
