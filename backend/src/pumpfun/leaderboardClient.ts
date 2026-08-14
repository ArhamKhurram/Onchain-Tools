// pump.fun PnL LEADERBOARD client — the THIRD access path.
//
// The other two live in client.ts: the shared `x-api-key` callouts path
// (coin-communities.xyz) and the keyless profile-api path
// (profile-api.pump.fun). This one is frontend-api-v3.pump.fun, authorized by a
// PER-USER session COOKIE — the user's own pump.fun `auth_token` JWT — with NO
// x-api-key and NO Authorization bearer. It is a separate file precisely so the
// shared-key world and the per-user-cookie world never blur: a bug that sent one
// credential to the other's endpoint would be a real leak, so they do not share a
// request method.
//
// CREDENTIAL SAFETY (the load-bearing concern):
//   * The session token is passed in per call and read late from storage by the
//     ROUTE, never cached on this client and never held in module state.
//   * It travels in exactly one place — the `Cookie: auth_token=<token>` header
//     of the outbound request — and is NEVER logged, NEVER returned in a response,
//     NEVER placed in an error message. Every error string here is built from the
//     request path plus vendor-authored text, exactly the discipline client.ts
//     documents for its x-api-key. The network-throw branch constructs its own
//     detail rather than forwarding a caught error, because that is the one path
//     where an error object could have observed the header.
//
// SHAPE IS VERIFIED against a live logged-in session, so each field is read by its
// exact key; a body whose `entries` is not an array throws PumpfunContractError
// rather than letting undefined leak.
//
// NOTE(cf_clearance): if frontend-api-v3 were bot-gated behind Cloudflare, a bare
// `auth_token` cookie could still 403 for want of a `cf_clearance` cookie. It is
// NOT bot-gated for these reads, so `auth_token` alone is expected to suffice —
// verified by the operator on reconnect.

import {
  PumpfunContractError,
  PumpfunRequestError,
  PumpfunSessionExpiredError,
} from './client.js';
import type {
  PumpLeaderboardEntry,
  PumpLeaderboardPeriod,
  PumpLeaderboardSort,
} from './types.js';

const BASE = 'https://frontend-api-v3.pump.fun';

// The one leaderboard path. period/sort/limit ride as query params (built per call).
const LEADERBOARD_PATH = '/pnl-leaderboard';

// Same 10s ceiling as the keyed client: a leaderboard read backs a console panel,
// so a slow call should fail and let the caller retry rather than hang a request.
const TIMEOUT_MS = 10_000;

// Cap vendor error text on the way out, matching client.ts. The token never
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

/**
 * Narrow one leaderboard row. Returns null (drop, don't throw) for a non-object
 * row or one missing `rank`/`walletAddress` — rank orders the board and the
 * wallet is the dedup/track key, so a row lacking either is unusable. Every other
 * field is read by its exact (verified) key and degrades to null.
 */
function parseLeaderboardEntry(v: unknown): PumpLeaderboardEntry | null {
  if (!isRecord(v)) return null;
  const rank = num(v.rank);
  const walletAddress = str(v.walletAddress);
  if (rank === null || walletAddress === null) return null;
  return {
    rank,
    walletAddress,
    username: str(v.username),
    xUsername: str(v.xUsername),
    profileImage: str(v.profileImage),
    pnlSol: num(v.pnlSol),
    pnlUsd: num(v.pnlUsd),
    pnlPercent: num(v.pnlPercent),
    realizedPnlSol: num(v.realizedPnlSol),
    realizedPnlUsd: num(v.realizedPnlUsd),
    unrealizedPnlSol: num(v.unrealizedPnlSol),
    unrealizedPnlUsd: num(v.unrealizedPnlUsd),
    buySpendSol: num(v.buySpendSol),
    lastRefreshedAtMs: num(v.lastRefreshedAtMs),
  };
}

/**
 * Extract the row array from the verified `{ entries: [...] }` envelope. A body
 * whose `entries` is absent or not an array (including a bare array, or an error
 * page that parsed as some other object) is the "unexpected shape" case and
 * throws here rather than yielding an empty board that would read as "no data".
 */
function extractRows(raw: unknown, endpoint: string): unknown[] {
  if (isRecord(raw) && Array.isArray(raw.entries)) return raw.entries;
  throw new PumpfunContractError(endpoint, 'expected an "entries" array of leaderboard rows');
}

/** Options for a leaderboard fetch. `sort` defaults to `combined`. */
export interface LeaderboardFetchOptions {
  sort?: PumpLeaderboardSort;
  limit?: number;
}

// Default rows to request upstream when the route does not specify. The route
// fetches the full board once per (user, period) and slices per request, so it
// asks for its own max; this default only covers a direct call.
const DEFAULT_FETCH_LIMIT = 100;

/**
 * The keyed-with-cookie leaderboard client. Stateless: the token is a per-call
 * argument, never a field, so one shared instance serves every user without any
 * risk of one user's token bleeding into another's request.
 */
export class PumpfunLeaderboardClient {
  /**
   * Low-level GET carrying the USER's session cookie. Sends NO x-api-key and NO
   * Authorization bearer — this path is authorized by the `auth_token` cookie
   * alone. `credentials: 'omit'` keeps the ambient cookie jar out; the one cookie
   * we want rides as an explicit header.
   *
   * A 401/403 here is the user's session lapsing, NOT the app key being refused,
   * so it maps to PumpfunSessionExpiredError ('auth-expired') → the route tells
   * the UI to reconnect. Every other failure reuses the shared taxonomy.
   *
   * `endpoint` is the query-free path used to label errors, kept distinct from
   * the `url` actually fetched so an error message never carries the query string
   * (which is only period/sort/limit — non-sensitive, but kept out for tidiness).
   */
  private async get(token: string, url: string, endpoint: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { cookie: `auth_token=${token}`, accept: 'application/json' },
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Construct the detail from context — do NOT forward the caught error. This
      // is the one call frame where the token is on the request object, and an
      // error that echoed the request could carry it. undici does not do that
      // today, but the discipline must not depend on that staying true.
      const detail = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
      throw new PumpfunRequestError(endpoint, 0, detail);
    }

    if (res.status === 401 || res.status === 403) throw new PumpfunSessionExpiredError(endpoint);

    const text = await res.text();
    if (!res.ok) {
      // Vendor-authored body, capped. The token travels only in a request
      // header and is never echoed in a response, so this carries no credential.
      throw new PumpfunRequestError(endpoint, res.status, text.slice(0, VENDOR_ERROR_TEXT_LIMIT));
    }

    if (text.length === 0) throw new PumpfunContractError(endpoint, 'empty body');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PumpfunContractError(endpoint, 'body was not JSON');
    }
  }

  /**
   * The PnL leaderboard for a period. `period`, `sort` and `limit` are QUERY
   * params on `/pnl-leaderboard` (not a path segment). The session token is read
   * late by the route and passed in here; it is never retained after this call
   * returns.
   */
  async getPnlLeaderboard(
    token: string,
    period: PumpLeaderboardPeriod,
    options: LeaderboardFetchOptions = {},
  ): Promise<PumpLeaderboardEntry[]> {
    const query = new URLSearchParams({
      period,
      sort: options.sort ?? 'combined',
      limit: String(options.limit ?? DEFAULT_FETCH_LIMIT),
    });
    const raw = await this.get(token, `${BASE}${LEADERBOARD_PATH}?${query.toString()}`, LEADERBOARD_PATH);
    return extractRows(raw, LEADERBOARD_PATH)
      .map(parseLeaderboardEntry)
      .filter((e): e is PumpLeaderboardEntry => e !== null);
  }
}

/** Process-wide client. Stateless (token is per-call), so one instance is plenty. */
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
