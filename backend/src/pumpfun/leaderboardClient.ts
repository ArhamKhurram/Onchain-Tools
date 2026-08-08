// pump.fun callout LEADERBOARD client — the THIRD access path.
//
// The other two live in client.ts: the shared `x-api-key` callouts path
// (coin-communities.xyz) and the keyless profile-api path
// (profile-api.pump.fun). This one is coin-communities.xyz again, but authorized
// by a PER-USER bearer — the user's own pump.fun session JWT — with NO x-api-key.
// It is a separate file precisely so the shared-key world and the per-user-bearer
// world never blur: a bug that sent one credential to the other's endpoint would
// be a real leak, so they do not share a request method.
//
// CREDENTIAL SAFETY (the load-bearing concern):
//   * The bearer is passed in per call and read late from storage by the ROUTE,
//     never cached on this client and never held in module state.
//   * It travels in exactly one place — the Authorization header of the outbound
//     request — and is NEVER logged, NEVER returned in a response, NEVER placed
//     in an error message. Every error string here is built from the request path
//     plus vendor-authored text, exactly the discipline client.ts documents for
//     its x-api-key. The network-throw branch constructs its own detail rather
//     than forwarding a caught error, because that is the one path where an error
//     object could have observed the header.
//
// SHAPE IS UNVERIFIED: we have no live bearer to probe with, so every response is
// narrowed defensively, each field is read from several plausible key spellings,
// and a mismatch throws PumpfunContractError rather than letting undefined leak.
// TODO(verify): confirm the envelope and field names against a live pump session.

import {
  PumpfunContractError,
  PumpfunRequestError,
  PumpfunSessionExpiredError,
} from './client.js';
import type { PumpLeaderboardEntry, PumpLeaderboardTimeframe } from './types.js';

const BASE = 'https://api.coin-communities.xyz/api/v1';

// Same 10s ceiling as the keyed client: a leaderboard read backs a console panel,
// so a slow call should fail and let the caller retry rather than hang a request.
const TIMEOUT_MS = 10_000;

// Cap vendor error text on the way out, matching client.ts. The bearer never
// appears in a response body, so passing a capped slice through cannot leak it.
const VENDOR_ERROR_TEXT_LIMIT = 500;

// --- Local narrowers. Deliberately NOT imported from client.ts (they are
// module-private there): the leaderboard row is a different shape, and copying
// the three tiny predicates keeps this path self-contained rather than widening
// client.ts's export surface with internals. Same drop-not-throw contract. ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Their numeric fields (pnl, market cap) sometimes arrive as strings.
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** First non-null string across a set of candidate keys (shape is unverified). */
function pickStr(r: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const s = str(r[k]);
    if (s !== null) return s;
  }
  return null;
}

/** First non-null number across a set of candidate keys. */
function pickNum(r: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const n = num(r[k]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Narrow one leaderboard row. Returns null (drop, don't throw) for a non-object
 * row or one with no wallet address — the wallet is the dedup/track key, the
 * leaderboard analogue of a callout's `id`, so a row without it is unusable.
 *
 * TODO(verify): the candidate key spellings below are guesses. Confirm which the
 * live API actually sends and prune the rest.
 */
function parseLeaderboardEntry(v: unknown): PumpLeaderboardEntry | null {
  if (!isRecord(v)) return null;
  const walletAddress = pickStr(v, 'walletAddress', 'wallet', 'address', 'walletAddr');
  if (!walletAddress) return null;
  return {
    rank: pickNum(v, 'rank', 'position'),
    walletAddress,
    userId: pickStr(v, 'userId', 'user_id', 'id'),
    username: pickStr(v, 'username', 'handle', 'userHandle'),
    displayName: pickStr(v, 'displayName', 'display_name', 'name'),
    profileImageUrl: pickStr(v, 'profileImageUrl', 'profile_image_url', 'avatarUrl', 'avatar'),
    userTwitterUrl: pickStr(v, 'userTwitterUrl', 'twitterUrl', 'twitter'),
    pnlUsd: pickNum(v, 'pnlUsd', 'pnl_usd', 'pnl', 'realizedPnl', 'realized_pnl'),
    calloutCount: pickNum(v, 'calloutCount', 'callout_count', 'calls', 'callCount'),
    winRate: pickNum(v, 'winRate', 'win_rate', 'hitRate', 'hit_rate'),
  };
}

/**
 * Extract the row array from an unverified envelope. The API might return a bare
 * array or wrap it under any of several keys, so accept the shapes we can and
 * throw unexpected-shape for a body carrying no recognizable array. A plain
 * object with no array member (the "non-array body" case) throws here.
 */
function extractRows(raw: unknown, endpoint: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    for (const key of ['leaderboard', 'data', 'callers', 'entries', 'rows', 'results', 'items']) {
      const candidate = raw[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  throw new PumpfunContractError(endpoint, 'expected an array of leaderboard rows');
}

/**
 * The keyed-with-bearer leaderboard client. Stateless: the bearer is a per-call
 * argument, never a field, so one shared instance serves every user without any
 * risk of one user's token bleeding into another's request.
 */
export class PumpfunLeaderboardClient {
  /**
   * Low-level GET carrying the USER's bearer. Sends NO x-api-key (this path is
   * authorized by the bearer alone) and NO cookies (`credentials: 'omit'`).
   *
   * A 401/403 here is the user's session lapsing, NOT the app key being refused,
   * so it maps to PumpfunSessionExpiredError ('auth-expired') → the route tells
   * the UI to reconnect. Every other failure reuses the shared taxonomy.
   */
  private async get(bearer: string, path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Construct the detail from context — do NOT forward the caught error. This
      // is the one call frame where the bearer is on the request object, and an
      // error that echoed the request could carry it. undici does not do that
      // today, but the discipline must not depend on that staying true.
      const detail = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
      throw new PumpfunRequestError(path, 0, detail);
    }

    if (res.status === 401 || res.status === 403) throw new PumpfunSessionExpiredError(path);

    const text = await res.text();
    if (!res.ok) {
      // Vendor-authored body, capped. The bearer travels only in a request
      // header and is never echoed in a response, so this carries no credential.
      throw new PumpfunRequestError(path, res.status, text.slice(0, VENDOR_ERROR_TEXT_LIMIT));
    }

    if (text.length === 0) throw new PumpfunContractError(path, 'empty body');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PumpfunContractError(path, 'body was not JSON');
    }
  }

  /**
   * The callout leaderboard for a window. The timeframe is a PATH segment
   * (`7d|30d|all`), not a query param. Bearer is read late by the route and
   * passed in here; it is never retained after this call returns.
   */
  async getCalloutLeaderboard(
    bearer: string,
    timeframe: PumpLeaderboardTimeframe,
  ): Promise<PumpLeaderboardEntry[]> {
    const path = `/leaderboard/callouts/${encodeURIComponent(timeframe)}`;
    const raw = await this.get(bearer, path);
    return extractRows(raw, path)
      .map(parseLeaderboardEntry)
      .filter((e): e is PumpLeaderboardEntry => e !== null);
  }

  /** The ranked-callers board (no window). Same bearer + narrowing discipline. */
  async getRankedCallers(bearer: string): Promise<PumpLeaderboardEntry[]> {
    const path = '/leaderboard/callouts/ranked';
    const raw = await this.get(bearer, path);
    return extractRows(raw, path)
      .map(parseLeaderboardEntry)
      .filter((e): e is PumpLeaderboardEntry => e !== null);
  }
}

/** Process-wide client. Stateless (bearer is per-call), so one instance is plenty. */
let shared: PumpfunLeaderboardClient | null = null;

export function getPumpfunLeaderboardClient(): PumpfunLeaderboardClient {
  if (!shared) shared = new PumpfunLeaderboardClient();
  return shared;
}

// ---------------------------------------------------------------------------
// JWT helpers + status projection. Kept here (exported) so they are unit-testable
// without a route or a network. NONE of these ever surface the raw token.
// ---------------------------------------------------------------------------

/**
 * True if a string is shaped like a JWT: three non-empty base64url segments.
 * A cheap structural gate on connect so obvious junk never reaches storage. It
 * does NOT verify the signature — pump.fun issued the token, not us.
 */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/**
 * Decode a JWT's `exp` claim (seconds since epoch) WITHOUT verifying it. Returns
 * null when the token is malformed, the payload is not JSON, or `exp` is absent
 * or non-numeric. Decoding is defensive: a bad token simply yields no expiry, it
 * never throws.
 */
export function decodeJwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    const payload: unknown = JSON.parse(payloadJson);
    if (isRecord(payload) && typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      return payload.exp;
    }
  } catch {
    // Not decodable — treated as "no known expiry".
  }
  return null;
}

/** The status a connect/status read returns. NEVER carries the token itself. */
export interface PumpSessionStatus {
  connected: boolean;
  /** ISO expiry from the JWT's `exp`, when decodable. */
  expiresAt?: string;
  /** ISO timestamp the token was last stored. */
  updatedAt?: string;
}

/**
 * Project a stored session into the safe, token-free status object a route may
 * return. Passing null yields `{ connected: false }`. This is the ONLY shape any
 * connect/status route sends back — the token stays server-side by construction,
 * because it is simply not a field of the return type.
 */
export function sessionStatus(
  session: { token: string; updatedAt: string } | null,
): PumpSessionStatus {
  if (!session) return { connected: false };
  const status: PumpSessionStatus = { connected: true, updatedAt: session.updatedAt };
  const exp = decodeJwtExpiry(session.token);
  if (exp !== null) status.expiresAt = new Date(exp * 1000).toISOString();
  return status;
}
