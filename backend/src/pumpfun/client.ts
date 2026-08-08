// pump.fun callouts client (coin-communities.xyz).
//
// WHY THIS IS PLAIN fetch, UNLIKE fomo/: coin-communities.xyz is NOT
// Cloudflare-gated. A server-side fetch with the shared `x-api-key` returns 200,
// so there is no browser, no Playwright, no VPS worker, no proxy here — only the
// SHAPE of fomo/ (client + cache + routes + types) is mirrored, none of its
// machinery.
//
// The error-handling discipline is borrowed instead from
// sniper/venue/slotsharkDashboard.ts: every response is narrowed at runtime and
// a mismatch throws a typed error rather than letting `undefined` leak upstream.
// A documented API is not a versioned one; an UNdocumented one even less so, so a
// shape change must surface as PumpfunContractError, an HTML error page as
// PumpfunRequestError, and neither as a silently-empty result.
//
// SECURITY: the `x-api-key` is a credential. It is a shared app key, but it is
// what authorizes the reads, so it is treated exactly like the sniper's venue
// token — read late from env, used once per call, and NEVER logged, NEVER
// returned in a response, NEVER interpolated into an error message. Every error
// string in this file is constructed from a fixed path + a vendor-authored body,
// never from anything carrying the key.

import type { PumpCallout, PumpFeedItem, PumpCommunity, PumpUser } from './types.js';

const BASE = 'https://api.coin-communities.xyz/api/v1';

// The API answers a settings/console screen, not a fire path — a slow call
// should fail and let the caller retry rather than hold a request open.
const TIMEOUT_MS = 10_000;

// Bound how much vendor error text rides out on a PumpfunRequestError. Enough to
// carry an actionable message, capped so an HTML error page from a proxy cannot
// flood a log. The key never appears in a response body, so passing this through
// does not risk leaking it.
const VENDOR_ERROR_TEXT_LIMIT = 500;

/**
 * The four ways a pump.fun read can fail, as a discriminant the router maps to
 * HTTP without instanceof-chaining. Kept deliberately parallel to the
 * dead/auth/contract split in slotsharkDashboard.ts.
 */
export type PumpfunErrorKind =
  | 'config-missing' // PUMPFUN_API_KEY not set — the module is inert.
  | 'auth-rejected' // 401/403 — the key was refused.
  | 'unexpected-shape' // 2xx, but not the shape we parse — the API changed.
  | 'request-failed'; // network, timeout, 5xx, or any other non-2xx.

/**
 * Base class for every pump.fun failure. Carries a `kind` so routes.ts can map to
 * a status code by discriminant rather than by fragile instanceof order.
 *
 * INVARIANT: no subclass ever includes the API key in `message`. Messages are
 * built from the request path and vendor-authored text only.
 */
export class PumpfunError extends Error {
  constructor(
    readonly kind: PumpfunErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'PumpfunError';
  }
}

export class PumpfunConfigError extends PumpfunError {
  constructor() {
    super('config-missing', 'PUMPFUN_API_KEY is not set; the pump.fun module is inert.');
    this.name = 'PumpfunConfigError';
  }
}

export class PumpfunAuthError extends PumpfunError {
  constructor(readonly endpoint: string) {
    super('auth-rejected', `pump.fun API rejected the x-api-key for ${endpoint}.`);
    this.name = 'PumpfunAuthError';
  }
}

/** 2xx, but not the shape we parse: coin-communities.xyz changed their API. */
export class PumpfunContractError extends PumpfunError {
  constructor(
    readonly endpoint: string,
    detail: string,
  ) {
    super('unexpected-shape', `pump.fun API returned an unexpected shape from ${endpoint}: ${detail}`);
    this.name = 'PumpfunContractError';
  }
}

/** Network, timeout, 5xx, or any other non-2xx that is not an auth refusal. */
export class PumpfunRequestError extends PumpfunError {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    detail: string,
  ) {
    super('request-failed', `pump.fun API call to ${endpoint} failed (${status}): ${detail}`);
    this.name = 'PumpfunRequestError';
  }
}

/**
 * Resolve the API key from env, honouring the OCT_/TRENCHCORD_ dual-brand
 * convention as a trivial fallback. Read late (per call) so the module self-gates
 * on the key the way FOMO/missed-runner self-gate on Supabase: unset means inert,
 * not a boot failure. Returns null when unconfigured.
 */
export function resolvePumpfunApiKey(): string | null {
  return (
    process.env.PUMPFUN_API_KEY ||
    process.env.OCT_PUMPFUN_API_KEY ||
    process.env.TRENCHCORD_PUMPFUN_API_KEY ||
    null
  );
}

/** True when a key is present. Routes call this to fail closed with a clean 503. */
export function isPumpfunConfigured(): boolean {
  return resolvePumpfunApiKey() !== null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- Field narrowers. Absent/wrong-typed scalars degrade to null/false rather
// than throwing: one missing field should cost that field, not the row. ---

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Their numeric fields (price, market cap) sometimes arrive as strings.
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function bool(v: unknown): boolean {
  return v === true;
}

/**
 * Narrow one callout row. Returns null rather than throwing so a single malformed
 * entry does not blank the whole list. `id` is the one hard requirement: a row
 * without it cannot be keyed, deduped or linked, so it is unusable.
 */
function parseCallout(v: unknown): PumpCallout | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  return {
    id,
    communityId: str(v.communityId),
    userId: str(v.userId),
    businessId: str(v.businessId),
    username: str(v.username),
    displayName: str(v.displayName),
    profileImageUrl: str(v.profileImageUrl),
    content: str(v.content),
    mediaUrl: str(v.mediaUrl),
    likeCount: num(v.likeCount),
    liked: bool(v.liked),
    createdAt: str(v.createdAt),
    multiplier: num(v.multiplier),
    maxMultiplier: num(v.maxMultiplier),
    maxMultiplierAt: str(v.maxMultiplierAt),
    calloutPrice: num(v.calloutPrice),
    calloutMarketCap: num(v.calloutMarketCap),
    isSpam: bool(v.isSpam),
    isHarmful: bool(v.isHarmful),
    userTwitterUrl: str(v.userTwitterUrl),
    followerCount: num(v.followerCount),
    replyCount: num(v.replyCount),
    tokenAddress: str(v.tokenAddress),
    walletAddress: str(v.walletAddress),
    source: str(v.source),
    deletedAt: str(v.deletedAt),
    deletedReason: str(v.deletedReason),
    mentions: Array.isArray(v.mentions) ? v.mentions : [],
  };
}

/** Narrow one feed row. Same drop-not-throw rule; `id` is mandatory. */
function parseFeedItem(v: unknown): PumpFeedItem | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  return {
    id,
    communityId: str(v.communityId),
    tokenAddress: str(v.tokenAddress),
    tokenSymbol: str(v.tokenSymbol),
    tokenImageUrl: str(v.tokenImageUrl),
    content: str(v.content),
    mediaUrl: str(v.mediaUrl),
    username: str(v.username),
    displayName: str(v.displayName),
    profileImageUrl: str(v.profileImageUrl),
    followerCount: num(v.followerCount),
    likeCount: num(v.likeCount),
    replyCount: num(v.replyCount),
    userTwitterUrl: str(v.userTwitterUrl),
    createdAt: str(v.createdAt),
    walletAddress: str(v.walletAddress),
    source: str(v.source),
  };
}

/**
 * Narrow one community row. `tokenAddressHint` is the mint when it came from the
 * path (single-community endpoint), where the body omits it; for `top` rows it is
 * undefined and the address is read from the row itself. Returns null only when
 * the value is not an object — communities carry no single mandatory scalar the
 * way callouts carry `id`, so an object with all-null fields is still a row.
 */
function parseCommunity(v: unknown, tokenAddressHint?: string): PumpCommunity | null {
  if (!isRecord(v)) return null;
  return {
    tokenAddress: tokenAddressHint ?? str(v.tokenAddress),
    tokenSymbol: str(v.tokenSymbol),
    tokenImageUrl: str(v.tokenImageUrl),
    chainId: num(v.chainId),
    postCount: num(v.postCount),
    memberCount: num(v.memberCount),
    totalLikes: num(v.totalLikes),
    latestPostAt: str(v.latestPostAt),
    community: isRecord(v.community) ? v.community : null,
  };
}

function parseUser(v: unknown): PumpUser {
  // Callers get a profile object even for a wallet with sparse data; the shape is
  // asserted (must be an object) upstream, so here every field simply degrades.
  const r = isRecord(v) ? v : {};
  return {
    userId: str(r.userId),
    twitterId: str(r.twitterId),
    username: str(r.username),
    displayName: str(r.displayName),
    profileImageUrl: str(r.profileImageUrl),
  };
}

export class PumpfunClient {
  /**
   * Low-level GET. Reads the key late, sends it as `x-api-key`, and sends NO
   * credentials — the endpoint is authorized by the header alone and a stray
   * cookie would be the only other identity on the wire (Node fetch sends none by
   * default; `credentials: 'omit'` states the intent regardless).
   *
   * Returns parsed JSON as `unknown`; the per-endpoint methods narrow it. Throws
   * the typed taxonomy, never a raw error that could carry the key.
   */
  private async get(path: string): Promise<unknown> {
    const key = resolvePumpfunApiKey();
    if (!key) throw new PumpfunConfigError();

    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'GET',
        headers: { 'x-api-key': key, accept: 'application/json' },
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Construct the detail rather than forwarding the caught error: this is the
      // one path where the key is on the request object, and an error that echoed
      // the request could plausibly carry it. undici does not do that today, but
      // the discipline does not depend on that staying true.
      const detail = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
      throw new PumpfunRequestError(path, 0, detail);
    }

    if (res.status === 401 || res.status === 403) throw new PumpfunAuthError(path);

    const text = await res.text();
    if (!res.ok) {
      // Vendor-authored body, capped. Contains no credential (the key travels in
      // a request header, never echoed in a response).
      throw new PumpfunRequestError(path, res.status, text.slice(0, VENDOR_ERROR_TEXT_LIMIT));
    }

    if (text.length === 0) throw new PumpfunContractError(path, 'empty body');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A 200 that is not JSON is almost always an HTML interstitial or error
      // page — an API change or an infra hiccup, not data.
      throw new PumpfunContractError(path, 'body was not JSON');
    }
  }

  /** A token's public callouts. Response envelope: `{ callouts: [...] }`. */
  async getTokenCallouts(mint: string): Promise<PumpCallout[]> {
    const path = `/communities/${encodeURIComponent(mint)}/callouts/public`;
    const raw = await this.get(path);
    if (!isRecord(raw) || !Array.isArray(raw.callouts)) {
      throw new PumpfunContractError(path, 'expected { callouts: [...] }');
    }
    return raw.callouts.map(parseCallout).filter((c): c is PumpCallout => c !== null);
  }

  /** A specific caller's callout history. THE per-trader tracking route. */
  async getWalletCallouts(address: string): Promise<PumpCallout[]> {
    const path = `/users/by-wallet/${encodeURIComponent(address)}/callouts`;
    const raw = await this.get(path);
    if (!isRecord(raw) || !Array.isArray(raw.callouts)) {
      throw new PumpfunContractError(path, 'expected { callouts: [...] }');
    }
    return raw.callouts.map(parseCallout).filter((c): c is PumpCallout => c !== null);
  }

  /** A caller's public profile, resolved from a wallet address. */
  async getWalletProfile(address: string): Promise<PumpUser> {
    const path = `/users/by-wallet/${encodeURIComponent(address)}`;
    const raw = await this.get(path);
    // A bare non-object (e.g. `null` for an unknown wallet) is a contract break —
    // the endpoint 404s a genuinely-missing wallet, so a 200 must be an object.
    if (!isRecord(raw)) throw new PumpfunContractError(path, 'expected a user object');
    return parseUser(raw);
  }

  /** The top communities board. Response envelope: `{ communities: [...] }`. */
  async getTopCommunities(): Promise<PumpCommunity[]> {
    const path = '/communities/top';
    const raw = await this.get(path);
    if (!isRecord(raw) || !Array.isArray(raw.communities)) {
      throw new PumpfunContractError(path, 'expected { communities: [...] }');
    }
    return raw.communities.map((c) => parseCommunity(c)).filter((c): c is PumpCommunity => c !== null);
  }

  /**
   * One token's community summary. The mint is the path param and is NOT in the
   * body, so it is injected into the parsed row.
   */
  async getCommunity(mint: string): Promise<PumpCommunity> {
    const path = `/communities/${encodeURIComponent(mint)}`;
    const raw = await this.get(path);
    const parsed = parseCommunity(raw, mint);
    if (!parsed) throw new PumpfunContractError(path, 'expected a community object');
    return parsed;
  }

  /** The public trending feed slice. Response envelope: `{ items: [...] }`. */
  async getTrendingFeed(): Promise<PumpFeedItem[]> {
    const path = '/feed/public';
    const raw = await this.get(path);
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new PumpfunContractError(path, 'expected { items: [...] }');
    }
    return raw.items.map(parseFeedItem).filter((i): i is PumpFeedItem => i !== null);
  }
}

/** Process-wide client. Stateless (no browser, no session), so one is plenty. */
let shared: PumpfunClient | null = null;

export function getPumpfunClient(): PumpfunClient {
  if (!shared) shared = new PumpfunClient();
  return shared;
}
