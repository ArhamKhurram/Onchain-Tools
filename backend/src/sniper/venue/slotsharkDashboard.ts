// Slotshark's DASHBOARD API — the undocumented control plane behind their web
// UI. Deliberately NOT in executors/: this is a sibling of the executor, not a
// kind of one.
//
// Three differences from executors/slotshark.ts justify the separate module:
//
//  1. DIFFERENT HOST. Execution is `{us,eu}.slotshark.xyz/buy`. The dashboard
//     API is `slotshark.xyz/api/dashboard/*` — the main site, not a regional
//     box. (Their regional hosts do route /api/dashboard through the same
//     bearer middleware, but the main host is what their own UI calls and the
//     one that answers with CORS headers, so it is what we call.)
//  2. DIFFERENT JOB. Nothing here spends. These calls read wallets and author
//     standing configs. `executeFire` remains the only function allowed to move
//     money, and it does not go through this module.
//  3. DIFFERENT STABILITY CONTRACT. `/buy` is documented. None of this is:
//     there is no OpenAPI spec, no version prefix, no rate-limit headers, and
//     no promise it will not change tomorrow. So every response is validated at
//     runtime and a shape change surfaces as VendorContractError rather than as
//     `undefined` leaking into a wallet form.
//
// SECURITY: the bearer is the SAME secret as the trading token — their
// dashboard stores it in localStorage under `dashApiKey` and it is byte-identical
// to the developer token that authorizes /buy, /sell and /wallets/withdraw. So
// this module inherits the executor's rules exactly: the token arrives as an
// argument, is used once, and is never logged, never returned, never cached.

const DASHBOARD_BASE = 'https://slotshark.xyz/api/dashboard';

// Well below the executor's 20s. Nothing here is on a fire path — these calls
// back a settings screen, and a slow one should fail and let the user retry
// rather than hold a request open.
const TIMEOUT_MS = 10_000;

/**
 * The vendor answered, but not with the shape we parse. Distinct from a network
 * or auth failure because the operator response differs: this means Slotshark
 * changed their API and OCT needs a code change, not a retry.
 */
export class VendorContractError extends Error {
  constructor(
    readonly endpoint: string,
    detail: string,
  ) {
    super(`Slotshark dashboard API returned an unexpected shape from ${endpoint}: ${detail}`);
    this.name = 'VendorContractError';
  }
}

/** Auth rejected, or the token lacks dashboard access. */
export class VendorAuthError extends Error {
  constructor(readonly endpoint: string) {
    super(`Slotshark rejected the venue credential for ${endpoint}.`);
    this.name = 'VendorAuthError';
  }
}

/** Anything else — network, timeout, 5xx, or an undisclosed rate limit. */
export class VendorRequestError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Slotshark dashboard API call to ${endpoint} failed (${status}): ${detail}`);
    this.name = 'VendorRequestError';
  }
}

/**
 * A trading wallet as Slotshark sees it.
 *
 * `nonceCount` is their "task accounts" — durable nonce accounts. A Solana
 * transaction signed against a `recent_blockhash` expires in ~60-90s, which is
 * useless for a pre-signed snipe; a durable nonce does not expire until it is
 * advanced, so a buy can sit signed and ready.
 *
 * Semantics confirmed by the Slotshark dev (2026-08-08): every transaction
 * consumes one, buy or sell alike, and it is released as soon as that
 * transaction confirms. So this is a POOL OF CONCURRENT IN-FLIGHT
 * TRANSACTIONS that recycles in roughly a confirmation, not a per-position
 * allocation. The constraint is a burst, not a sustained rate.
 *
 * Two consequences worth carrying into any capacity check:
 *
 *  - A multi-leg ladder entry consumes one PER LEG, simultaneously.
 *  - SELLS DRAW FROM THE SAME POOL, including limit-sell ladders. Exits
 *    therefore compete with entries, and the dangerous moment is the one where
 *    several positions hit their trigger at once — precisely when the pool is
 *    also busiest. Failing to enter costs an opportunity; failing to exit costs
 *    the position, so capacity should be sized with headroom for the sells
 *    rather than spent entirely on concurrent buys.
 */
export interface VenueWallet {
  pubkey: string;
  label: string;
  /** Durable nonce accounts deployed. Their UI calls these "task accounts". */
  nonceCount: number;
  enabled: boolean;
}

export interface VenueWalletBalance {
  pubkey: string;
  balanceSol: number;
  balanceLamports: number;
}

export interface SlotsharkDashboardConfig {
  /** The venue bearer. Read late by the caller, never held by this module. */
  apiToken: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Narrow an unknown wallet row. Returns null rather than throwing so one
 * malformed entry does not blank the whole list — a new wallet type on their
 * side should cost the user that row, not the screen.
 */
function parseWallet(v: unknown): VenueWallet | null {
  if (!isRecord(v)) return null;
  const { pubkey, label, nonceCount, enabled } = v;
  if (typeof pubkey !== 'string' || pubkey.length === 0) return null;
  return {
    pubkey,
    label: typeof label === 'string' ? label : '',
    // Absent is not zero: an older/newer response without the field means we do
    // not know the ceiling. 0 would claim we do, and would then fail every
    // maxOpen check. Treat unknown as unknown at the call site via -1.
    nonceCount: typeof nonceCount === 'number' && Number.isFinite(nonceCount) ? nonceCount : -1,
    enabled: enabled === true,
  };
}

export class SlotsharkDashboard {
  constructor(private cfg: SlotsharkDashboardConfig) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${DASHBOARD_BASE}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Deliberately does not include the caught error verbatim: undici does not
      // put request headers in Error.message today, but this is the one place a
      // bearer could plausibly ride out on an error path, so the message is
      // constructed rather than forwarded.
      const detail = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
      throw new VendorRequestError(path, 0, detail);
    }

    if (res.status === 401 || res.status === 403) throw new VendorAuthError(path);

    const text = await res.text();
    if (!res.ok) {
      // Their errors are `{"error":"...","field":"params.targetHandle"}`. Pass
      // the text through — it is vendor-authored operator guidance and contains
      // no credential — but cap it so a stray HTML error page cannot flood logs.
      throw new VendorRequestError(path, res.status, text.slice(0, 300));
    }

    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new VendorContractError(path, 'body was not JSON');
    }
  }

  /**
   * Every trading wallet on the account.
   *
   * Their response is a bare array, not `{wallets:[...]}` — unlike the config
   * endpoints, which do wrap. Both shapes are accepted here because that
   * inconsistency is exactly the kind of thing an undocumented API changes.
   */
  async listWallets(): Promise<VenueWallet[]> {
    const raw = await this.call('GET', '/wallets');
    const arr = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.wallets) ? raw.wallets : null;
    if (!arr) throw new VendorContractError('/wallets', 'expected an array of wallets');
    return arr.map(parseWallet).filter((w): w is VenueWallet => w !== null);
  }

  /**
   * Balance for one wallet. Separate call per wallet — their own dashboard does
   * the same N+1, and there is no batch endpoint. Callers should fetch these
   * concurrently and tolerate individual failures rather than failing the list.
   */
  async walletBalance(pubkey: string): Promise<VenueWalletBalance> {
    const raw = await this.call('GET', `/wallets/${encodeURIComponent(pubkey)}/balance`);
    if (!isRecord(raw) || typeof raw.balanceSol !== 'number') {
      throw new VendorContractError('/wallets/:pubkey/balance', 'expected balanceSol');
    }
    return {
      pubkey,
      balanceSol: raw.balanceSol,
      balanceLamports:
        typeof raw.balanceLamports === 'number' ? raw.balanceLamports : Math.round(raw.balanceSol * 1e9),
    };
  }
}
