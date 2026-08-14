// The GLOBAL pump.fun callouts firehose (frontend-api-v3.pump.fun) plus the two
// keyless batch enrichers the app joins against it. This is a THIRD pump host,
// distinct from coin-communities (keyed) and profile-api (keyless activity):
//
//   GET  /callout/recent?limit=N[&pageToken=…]   → { callouts:[…], nextPageToken }
//   POST /users/batch      { addresses:[…] }      → [{ address, username, … }]
//   POST /coins-v2/mints   { mints:[…] }          → [{ mint, symbol, name, … }]
//
// All THREE are open — no cookie, no bearer, no x-api-key (verified live). The
// firehose is GLOBAL (every coin, no mint param) and cursor-paginated; pump's own
// web app doesn't time-poll it, so WE choose the cadence and diff by calloutId.
//
// KEY FACT the whole KOL-alert feature rests on: a callout's `userId` is the
// caller's WALLET ADDRESS (a base58 pubkey), which is why /users/batch keys on
// `addresses`. So matching a tracked caller to a callout is a plain string
// compare — no id→wallet resolution step. Enrichment (handle, avatar, ticker) is
// only needed for the callouts that already matched, to build the ping text.
//
// Error discipline mirrors client.ts: every response is narrowed and a fault
// throws the shared PumpfunError taxonomy, never a leaked undefined.

import { PumpfunRequestError, PumpfunContractError } from './client.js';

const FRONTEND_V3_BASE = 'https://frontend-api-v3.pump.fun';
const TIMEOUT_MS = 10_000;
const VENDOR_ERROR_TEXT_LIMIT = 500;

/** A single global-feed callout, narrowed. `calloutId` + `callerAddress` are the
 *  hard requirements (the dedup key and the match key); a row missing either is
 *  unusable and dropped. Numeric/text fields degrade to null. */
export interface RecentCallout {
  /** Dedup key across polls. */
  calloutId: string;
  /** The caller — a WALLET ADDRESS (pump uses the pubkey as the user id). */
  callerAddress: string;
  /** The coin called. */
  coinMint: string;
  /** Market cap at the moment of the call, USD. */
  marketCapUsd: number | null;
  /** The callout text. */
  thesis: string | null;
  /** Multiple since the call (1.1 = 1.1×). */
  multiple: number | null;
  /** Unix ms the callout was posted. */
  createdAt: number | null;
}

export interface RecentCalloutsPage {
  callouts: RecentCallout[];
  nextPageToken: string | null;
}

/** Caller identity for a wallet, from /users/batch. */
export interface CalloutUser {
  address: string;
  username: string | null;
  avatar: string | null;
}

/** Coin identity for a mint, from /coins-v2/mints. */
export interface CalloutCoin {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Narrow one raw callout. Drops (returns null) only when the two keys are
 * missing — calloutId (dedup) and userId/callerAddress (the match key) — so a
 * malformed row costs itself, not the poll.
 */
export function parseRecentCallout(v: unknown): RecentCallout | null {
  if (!isRecord(v)) return null;
  const calloutId = str(v.calloutId);
  const callerAddress = str(v.userId);
  const coinMint = str(v.coinMint);
  if (!calloutId || !callerAddress || !coinMint) return null;
  return {
    calloutId,
    callerAddress,
    coinMint,
    marketCapUsd: num(v.marketCap),
    thesis: str(v.thesis),
    multiple: num(v.multiple),
    createdAt: num(v.createdAt),
  };
}

export class PumpCalloutFeedClient {
  /** Keyless GET/POST to frontend-api-v3. Sends no credentials (the host takes
   *  none); a POST carries a JSON body. 201 and 200 both count as success. */
  private async fetch(
    path: string,
    init: { method: 'GET' } | { method: 'POST'; body: unknown },
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (init.method === 'POST') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }

    let res: Response;
    try {
      res = await fetch(`${FRONTEND_V3_BASE}${path}`, {
        method: init.method,
        headers,
        body,
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const detail = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
      throw new PumpfunRequestError(path, 0, detail);
    }

    const text = await res.text();
    if (!res.ok) throw new PumpfunRequestError(path, res.status, text.slice(0, VENDOR_ERROR_TEXT_LIMIT));
    if (text.length === 0) throw new PumpfunContractError(path, 'empty body');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PumpfunContractError(path, 'body was not JSON');
    }
  }

  /** One page of the global callouts firehose, newest first. */
  async getRecentCallouts(limit = 30, pageToken?: string): Promise<RecentCalloutsPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (pageToken) params.set('pageToken', pageToken);
    const path = `/callout/recent?${params.toString()}`;
    const raw = await this.fetch(path, { method: 'GET' });
    if (!isRecord(raw) || !Array.isArray(raw.callouts)) {
      throw new PumpfunContractError(path, 'expected { callouts: [...] }');
    }
    return {
      callouts: raw.callouts.map(parseRecentCallout).filter((c): c is RecentCallout => c !== null),
      nextPageToken: str(raw.nextPageToken),
    };
  }

  /**
   * Resolve caller identities for wallet addresses (handle + avatar). Returns a
   * Map keyed by address; an address with no profile simply won't be present.
   */
  async resolveUsers(addresses: string[]): Promise<Map<string, CalloutUser>> {
    const out = new Map<string, CalloutUser>();
    if (addresses.length === 0) return out;
    const path = '/users/batch';
    const raw = await this.fetch(path, { method: 'POST', body: { addresses } });
    const rows = Array.isArray(raw) ? raw : [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const address = str(row.address);
      if (!address) continue;
      out.set(address, { address, username: str(row.username), avatar: str(row.profile_image) });
    }
    return out;
  }

  /**
   * Resolve coin identities for mints (symbol + name + image). Returns a Map
   * keyed by mint; a mint with no metadata simply won't be present.
   */
  async resolveCoins(mints: string[]): Promise<Map<string, CalloutCoin>> {
    const out = new Map<string, CalloutCoin>();
    if (mints.length === 0) return out;
    const path = '/coins-v2/mints';
    const raw = await this.fetch(path, { method: 'POST', body: { mints } });
    const rows = Array.isArray(raw) ? raw : [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const mint = str(row.mint);
      if (!mint) continue;
      out.set(mint, { mint, symbol: str(row.symbol), name: str(row.name), image: str(row.image_uri) });
    }
    return out;
  }

  /**
   * Resolve a single pump @username to a caller (address + avatar). The follow
   * flow's entry point — a user types a handle, we store the wallet it maps to.
   * Returns null when the username is unknown (404). GET /users/{username} is
   * keyless and returns { address, username, profile_image, … }.
   */
  async resolveUsername(username: string): Promise<CalloutUser | null> {
    const path = `/users/${encodeURIComponent(username)}`;
    let raw: unknown;
    try {
      raw = await this.fetch(path, { method: 'GET' });
    } catch (err) {
      // An unknown handle 404s → request-failed with status 404. Treat as "no
      // such user" (null) rather than an upstream fault the caller must handle.
      if (err instanceof PumpfunRequestError && err.status === 404) return null;
      throw err;
    }
    if (!isRecord(raw)) return null;
    const address = str(raw.address);
    if (!address) return null;
    return { address, username: str(raw.username), avatar: str(raw.profile_image) };
  }
}

let shared: PumpCalloutFeedClient | null = null;

export function getPumpCalloutFeedClient(): PumpCalloutFeedClient {
  if (!shared) shared = new PumpCalloutFeedClient();
  return shared;
}
