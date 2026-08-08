// Slotshark's DASHBOARD API — `/api/dashboard/*`. Deliberately NOT in
// executors/: this is a sibling of the executor, not a kind of one.
//
// Two differences from executors/slotshark.ts justify the separate module:
//
//  1. DIFFERENT JOB. Nothing here spends. These calls read wallets and author
//     the standing Twitter Sniper configs. `executeFire` remains the only
//     function allowed to move money, and it does not go through this module.
//  2. DIFFERENT FAILURE HANDLING. The executor answers in the
//     dead/filled/unknown vocabulary a retry loop reads; a settings screen
//     wants to know WHY, so this throws a three-way taxonomy instead.
//
// SAME HOST FAMILY, and that changed on 2026-08-08. Slotshark's official docs
// place `/api/dashboard/*` on the REGIONAL hosts — `https://us.slotshark.xyz`
// and `https://eu.slotshark.xyz`, "use the region your account is on". This
// module previously called the bare `slotshark.xyz`, which answers but is
// undocumented; the region now arrives from the venue credential (its `region`
// column, narrowed by `narrowRegion`) exactly as it already does for /buy.
//
// The region stays a FIXED ENUM indexing a compile-time table, never operator
// input interpolated into a URL — that is threat T4 (SSRF), and the reasoning
// is spelled out on `narrowRegion` in executors/slotshark.ts.
//
// STABILITY. The endpoints are documented now, which is why the twitter config
// surface below exists at all, but every response is still narrowed at runtime:
// a documented API is not a versioned one, and a shape change must surface as
// VendorContractError rather than as `undefined` leaking into a wallet form.
//
// SECURITY: the bearer is the SAME secret as the trading token — their
// dashboard stores it in localStorage under `dashApiKey` and it is byte-identical
// to the developer token that authorizes /buy, /sell and /wallets/withdraw. So
// this module inherits the executor's rules exactly: the token arrives as an
// argument, is used once, and is never logged, never returned, never cached.

import { REGION_BASE_URLS, type SlotsharkRegion } from '../executors/slotshark.js';
import {
  buildFullBody,
  buildPatchBody,
  TWITTER_CONFIGS_PATH,
  TWITTER_MODES,
  TwitterConfigValidationError,
  type TwitterConfigBody,
  type TwitterConfigInput,
  type TwitterConfigPatch,
  type TwitterConfigResult,
  type TwitterMode,
} from './slotsharkTwitterConfig.js';

const DASHBOARD_PREFIX = '/api/dashboard';

// Well below the executor's 20s. Nothing here is on a fire path — these calls
// back a settings screen, and a slow one should fail and let the user retry
// rather than hold a request open.
const TIMEOUT_MS = 10_000;

/**
 * How much vendor error text rides out on a VendorRequestError.
 *
 * Generous on purpose: their untracked-handle refusal is "These handles are not
 * available for tracking: ..." followed by the offending handles, and that list
 * is the entire actionable content. Clipping it at a couple of hundred
 * characters would leave an operator with an error naming no handles. Still
 * bounded, so an HTML error page from a proxy cannot flood a log.
 */
const VENDOR_ERROR_TEXT_LIMIT = 1_000;

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
  /**
   * Which regional host the account lives on. Comes from the venue
   * credential's `region`, narrowed by `narrowRegion` — never free text.
   */
  region: SlotsharkRegion;
}

/**
 * One Twitter Sniper config as this module is willing to describe it.
 *
 * Deliberately narrow: the fields below are the ones the official docs pin
 * down, and a field invented here would be `undefined` on screen the first time
 * their response differs. A caller that needs the whole document should PUT a
 * config it built, not round-trip one it read.
 */
export interface VenueTwitterConfig {
  id: string;
  name: string;
  /**
   * `null` when Slotshark reports a mode this build does not know. Such a
   * config must NOT be patched: the params serializer is chosen by mode, and
   * guessing one would send the wrong keyword spelling at best.
   */
  modeType: TwitterMode | null;
  /** `null` means unlimited — the documented meaning of an absent maxBuyCount. */
  maxBuyCount: number | null;
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

/**
 * Narrow one config row. Returns null rather than throwing, on the same
 * principle as `parseWallet`: a row we cannot identify costs the operator that
 * row, not the screen. A row without a usable `id` is unusable — nothing can be
 * patched or deleted without one — so that is the only hard requirement.
 */
function parseTwitterConfig(v: unknown): VenueTwitterConfig | null {
  if (!isRecord(v)) return null;
  const { id, name, modeType, maxBuyCount } = v;
  if (typeof id !== 'string' || id.length === 0) return null;
  const mode = TWITTER_MODES.find((m) => m === modeType) ?? null;
  return {
    id,
    name: typeof name === 'string' ? name : '',
    modeType: mode,
    maxBuyCount: typeof maxBuyCount === 'number' && Number.isFinite(maxBuyCount) ? maxBuyCount : null,
  };
}

/** Throw the local refusal, or hand back the body it built. */
function unwrap(built: TwitterConfigResult<TwitterConfigBody>): TwitterConfigBody {
  if (!built.ok) throw new TwitterConfigValidationError(built.reason, built.detail);
  return built.value;
}

export class SlotsharkDashboard {
  constructor(private cfg: SlotsharkDashboardConfig) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${REGION_BASE_URLS[this.cfg.region]}${DASHBOARD_PREFIX}${path}`;
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
      // the text through VERBATIM — it is vendor-authored operator guidance,
      // contains no credential, and in the untracked-handles case it is the
      // only place the offending handles are named. Capped, not summarised.
      throw new VendorRequestError(path, res.status, text.slice(0, VENDOR_ERROR_TEXT_LIMIT));
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

  // -------------------------------------------------------------------------
  // Twitter Sniper configs.
  //
  // These author the tweet -> buy loop that runs INSIDE Slotshark. Creating one
  // does not bring it under OCT's caps or kill switch: Slotshark executes from
  // its own balance and tells OCT nothing when it fires. Writing a config here
  // is therefore the most consequential thing in this module, and the reason
  // every body is built by the validating serializers rather than assembled
  // inline.
  // -------------------------------------------------------------------------

  /** Every config on the account. Their envelope wraps: `{ "configs": [...] }`. */
  async listTwitterConfigs(): Promise<VenueTwitterConfig[]> {
    const raw = await this.call('GET', TWITTER_CONFIGS_PATH);
    if (!isRecord(raw) || !Array.isArray(raw.configs)) {
      // Not an empty list: rendering "no configs" for an account that has five
      // would invite an operator to create duplicates of rules already running.
      throw new VendorContractError(TWITTER_CONFIGS_PATH, 'expected { configs: [...] }');
    }
    return raw.configs.map(parseTwitterConfig).filter((c): c is VenueTwitterConfig => c !== null);
  }

  /**
   * Create one. 201 `{ "config": {...} }`.
   *
   * `modeType` is fixed at this moment and forever: it cannot be changed later
   * by PUT or PATCH, so a mode mistake is fixed by DELETE + create.
   */
  async createTwitterConfig(input: TwitterConfigInput): Promise<VenueTwitterConfig> {
    const raw = await this.call('POST', TWITTER_CONFIGS_PATH, unwrap(buildFullBody(input)));
    return this.expectConfig(raw, TWITTER_CONFIGS_PATH);
  }

  /**
   * FULL replace (PUT). Every field the config should end up with must be
   * present — this is not a merge, and an omitted `snipeParams.solAmount` on a
   * ca_scanner is the 0-SOL silent-no-fill case, which is why `buildFullBody`
   * refuses it rather than letting the omission through.
   *
   * `input.mode` must be the config's EXISTING mode. The vendor rejects a
   * change; passing a different one here buys a 400, not a converted config.
   */
  async replaceTwitterConfig(id: string, input: TwitterConfigInput): Promise<VenueTwitterConfig> {
    const path = `${TWITTER_CONFIGS_PATH}/${encodeURIComponent(id)}`;
    return this.expectConfig(await this.call('PUT', path, unwrap(buildFullBody(input))), path);
  }

  /**
   * PARTIAL update (PATCH). `params`, `snipeParams` and `taskTiming` merge one
   * level deep; ARRAYS REPLACE WHOLESALE, which is why every array in
   * `TwitterConfigPatch` is an `ArrayReplacement<T>` the caller has to name.
   */
  async patchTwitterConfig(id: string, patch: TwitterConfigPatch): Promise<VenueTwitterConfig> {
    const path = `${TWITTER_CONFIGS_PATH}/${encodeURIComponent(id)}`;
    return this.expectConfig(await this.call('PATCH', path, unwrap(buildPatchBody(patch))), path);
  }

  /**
   * Delete one. Their response is `{ "deletedAt": ... }`.
   *
   * The timestamp is returned as a string or null rather than asserted: the
   * delete either happened or the call threw, so a missing timestamp is a
   * display detail, not grounds for telling the operator the delete failed and
   * inviting them to run it again.
   */
  async deleteTwitterConfig(id: string): Promise<{ deletedAt: string | null }> {
    const path = `${TWITTER_CONFIGS_PATH}/${encodeURIComponent(id)}`;
    const raw = await this.call('DELETE', path);
    const deletedAt = isRecord(raw) && typeof raw.deletedAt === 'string' ? raw.deletedAt : null;
    return { deletedAt };
  }

  private expectConfig(raw: unknown, endpoint: string): VenueTwitterConfig {
    const parsed = isRecord(raw) ? parseTwitterConfig(raw.config) : null;
    if (!parsed) throw new VendorContractError(endpoint, 'expected { config: { id, ... } }');
    return parsed;
  }
}
