// pump.fun domain types for the console, mirrored from backend/src/pumpfun/types.ts.
//
// Duplicated rather than imported across the workspace boundary, exactly as
// types/sniper.ts is: the frontend has no tsconfig reference into backend/src,
// and @oct/shared (the only cross-workspace import) does not export these. The
// backend narrows every upstream row at runtime; here the shapes are the
// contract the narrowed JSON arrives in, so the fields match one-for-one and the
// nullable ones stay nullable.
//
// TWO HOSTS, TWO TRUST LEVELS (kept visible in the type split, same as the
// backend): the callout/community/profile surface is KEYED (coin-communities.xyz,
// 503 when PUMPFUN_API_KEY is unset) and the transaction/PnL/balance surface is
// KEYLESS (profile-api.pump.fun). A missing key blanks the former, never the
// latter — the UI keys off that.
//
// The pure helpers at the bottom (validation, formatting, the tracked-list
// reducer, trade-side derivation) are the unit-test targets — see
// frontend/test/pumpfun.test.ts.

// ---------------------------------------------------------------------------
// Callouts layer (KEYED — coin-communities.xyz)
// ---------------------------------------------------------------------------

/** A trader's call/reply/position on a token inside its community. */
export interface PumpCallout {
  id: string;
  communityId: string | null;
  userId: string | null;
  businessId: string | null;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  content: string | null;
  mediaUrl: string | null;
  likeCount: number | null;
  liked: boolean;
  createdAt: string | null;
  /** Current multiplier since the call (e.g. 2.5 = 2.5x). */
  multiplier: number | null;
  maxMultiplier: number | null;
  maxMultiplierAt: string | null;
  calloutPrice: number | null;
  calloutMarketCap: number | null;
  isSpam: boolean;
  isHarmful: boolean;
  userTwitterUrl: string | null;
  followerCount: number | null;
  replyCount: number | null;
  tokenAddress: string | null;
  walletAddress: string | null;
  source: string | null;
  deletedAt: string | null;
  deletedReason: string | null;
  mentions: unknown[];
}

/** A trending-feed item — leaner than a callout (no multiplier / call price). */
export interface PumpFeedItem {
  id: string;
  communityId: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenImageUrl: string | null;
  content: string | null;
  mediaUrl: string | null;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  followerCount: number | null;
  likeCount: number | null;
  replyCount: number | null;
  userTwitterUrl: string | null;
  createdAt: string | null;
  walletAddress: string | null;
  source: string | null;
}

/** A token's community summary. */
export interface PumpCommunity {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenImageUrl: string | null;
  chainId: number | null;
  postCount: number | null;
  memberCount: number | null;
  totalLikes: number | null;
  latestPostAt: string | null;
  community: Record<string, unknown> | null;
}

/** A caller's public profile, resolved from a wallet address. */
export interface PumpUser {
  userId: string | null;
  twitterId: string | null;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
}

// ---------------------------------------------------------------------------
// Wallet activity / PnL / balance (KEYLESS — profile-api.pump.fun)
// ---------------------------------------------------------------------------

/** Token metadata as it rides inside a swap leg or a transferred amount. */
export interface PumpTokenMeta {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  program: string | null;
  icon: string | null;
}

/** One mint + amount pair, with its metadata. `amount` is already decimal-scaled by the backend. */
export interface PumpTokenLeg {
  amount: number | null;
  mint: string | null;
  metadata: PumpTokenMeta | null;
}

/** A swap. `side` is BUY|SELL; the `token*`/`amount` fields are the derived non-SOL leg. */
export interface PumpSwapTransaction {
  type: 'SWAP';
  txHash: string;
  blockTime: number | null;
  fee: number | null;
  side: string | null;
  tokenIn: PumpTokenLeg | null;
  tokenOut: PumpTokenLeg | null;
  solValue: number | null;
  token: string | null;
  tokenSymbol: string | null;
  amount: number | null;
}

/** A transfer or a creator-fee claim — one shape, split by `type`. */
export interface PumpTransferTransaction {
  type: 'TRANSFER' | 'FEE_CLAIM';
  txHash: string;
  blockTime: number | null;
  fee: number | null;
  transactionType: string | null;
  direction: string | null;
  tokenTransferred: PumpTokenLeg | null;
  fromAddress: string | null;
  toAddress: string | null;
}

/** Any row whose `type` the backend does not model with dedicated fields (e.g. CREATE_COIN). */
export interface PumpOtherTransaction {
  type: 'OTHER';
  rawType: string | null;
  txHash: string;
  blockTime: number | null;
  fee: number | null;
  transactionType: string | null;
  raw: Record<string, unknown>;
}

/** A wallet-activity row: a discriminated union on `type`. */
export type PumpTransaction =
  | PumpSwapTransaction
  | PumpTransferTransaction
  | PumpOtherTransaction;

/** Cursor pagination envelope for the transactions list. */
export interface PumpPagination {
  hasMore: boolean;
  nextCursor: string | null;
  total: number | null;
}

/** One page of wallet activity: narrowed rows plus the cursor to continue. */
export interface PumpTransactionsPage {
  items: PumpTransaction[];
  pagination: PumpPagination;
}

/** A `{sol, usd}` money pair as it appears in the PnL response. */
export interface PumpMoney {
  sol: number | null;
  usd: number | null;
}

/** Per-token realized/unrealized PnL for a wallet, from the batch endpoint. */
export interface PumpTokenPnl {
  mint: string;
  unrealized: number | null;
  realized: number | null;
  totalBuySpend: PumpMoney | null;
  totalBuyAmount: number | null;
  hasTransfers: boolean;
  hasUntrustedBasis: boolean;
  fee: number | null;
  feeDetail: Record<string, unknown> | null;
}

/** A wallet's balance/holdings summary — opaque, passed through untouched. */
export type PumpBalanceSummary = Record<string, unknown>;

/**
 * One top holder of a coin (mirror of backend PumpHolder). Stitched server-side
 * from on-chain balance (Helius) + keyless PnL (profile-api). `name` is null
 * until pump-identity enrichment ships; the board renders the short wallet then.
 */
export interface PumpHolder {
  rank: number;
  wallet: string;
  name: string | null;
  amount: number | null;
  supplyPct: number | null;
  valueUsd: number | null;
  pnlUsd: number | null;
}

/** The top-holders board for one coin. `enriched` flags whether names are present. */
export interface PumpHoldersResponse {
  mint: string;
  holders: PumpHolder[];
  enriched: boolean;
}

// ---------------------------------------------------------------------------
// Tracked-trader list (localStorage, v1 — NO backend table)
//
// Tracking is client-only for now: there is no pumpfun_tracked_wallets table,
// so the list lives in localStorage keyed per browser, not per Supabase user.
// A future backend table would move this behind the storage interface; until
// then addTrackedWallet/removeTrackedWallet are the whole persistence contract
// and are unit-tested as pure reducers.
// ---------------------------------------------------------------------------

export const TRACKED_WALLETS_STORAGE_KEY = 'oct.pumpfun.trackedWallets';

export interface TrackedPumpWallet {
  address: string;
  /** Epoch ms the wallet was added — the list renders newest-first. */
  addedAt: number;
}

export type AddTrackedResult =
  | { ok: true; list: TrackedPumpWallet[] }
  | { ok: false; reason: 'invalid' | 'duplicate' };

/**
 * Add a wallet to the tracked list. Pure: returns a new list on success, or a
 * typed refusal the caller turns into an inline message. A junk address is
 * rejected before it can be tracked (invalid), and re-tracking an address
 * already present is a no-op refusal (duplicate) rather than a silent duplicate
 * row that would render twice and double every fetch.
 */
export function addTrackedWallet(
  list: TrackedPumpWallet[],
  rawAddress: string,
  now: number = Date.now(),
): AddTrackedResult {
  const address = rawAddress.trim();
  if (!isPumpWallet(address)) return { ok: false, reason: 'invalid' };
  if (list.some((w) => w.address === address)) return { ok: false, reason: 'duplicate' };
  return { ok: true, list: [{ address, addedAt: now }, ...list] };
}

/** Remove a wallet from the tracked list. Pure; a no-op when absent. */
export function removeTrackedWallet(list: TrackedPumpWallet[], address: string): TrackedPumpWallet[] {
  return list.filter((w) => w.address !== address);
}

/** Coerce an unknown parsed-JSON blob back into a tracked list, dropping junk rows. */
export function normalizeTrackedList(parsed: unknown): TrackedPumpWallet[] {
  if (!Array.isArray(parsed)) return [];
  const out: TrackedPumpWallet[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const address = (row as Record<string, unknown>).address;
    const addedAt = (row as Record<string, unknown>).addedAt;
    if (typeof address !== 'string' || !isPumpWallet(address) || seen.has(address)) continue;
    seen.add(address);
    out.push({ address, addedAt: typeof addedAt === 'number' ? addedAt : 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live callout feed (the `pump_callout` WS frame)
//
// A DIFFERENT shape from PumpCallout above, and deliberately so. PumpCallout is
// a coin-communities row — a caller's callout HISTORY, fetched on demand for a
// wallet or a token. What follows is the real-time push the callout poller
// sends to followers (backend/src/pumpfun/calloutPoller.ts → dispatch), which
// comes off pump's global firehose and carries only what that feed knows.
// ---------------------------------------------------------------------------

/** The `data` payload of a `pump_callout` WS frame, one-for-one with the poller. */
export interface PumpCalloutEvent {
  calloutId: string;
  callerAddress: string;
  username: string | null;
  avatar: string | null;
  coinMint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  marketCapUsd: number | null;
  thesis: string | null;
  multiple: number | null;
  /** Epoch ms from pump when present. */
  createdAt: number | null;
  /**
   * Peak multiple since the call. Recovered by the j7 path (backend
   * j7/mappers.ts); the pump-firehose poller sends null. Optional only so a
   * frame from an older backend still parses — the slice normalises it to null.
   */
  maxMultiplier?: number | null;
  /** Per-caller Pushover opt-in, echoed by the poller to gate the toast. */
  notify?: boolean;
}

/** A callout held in client state for the live feed. */
export interface PumpCalloutFeedEntry extends PumpCalloutEvent {
  /** The call's own timestamp when pump gave one, else arrival. */
  occurredAt: number;
  receivedAt: number;
  /** Stable React key — calloutId is unique but this keeps ordering explicit. */
  key: string;
}

// ---------------------------------------------------------------------------
// Validation — mirrors backend/src/pumpfun/routes.ts so the UI rejects exactly
// what the API would 400 on, before spending a request.
// ---------------------------------------------------------------------------

// Base58 (no 0/O/I/l), 32–44 chars — a Solana address.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// An EVM 0x-hex address, accepted for token mints on the chains coin-communities indexes.
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

/** A trackable wallet address: base58 only (wallets are Solana-only here). */
export function isPumpWallet(value: string): boolean {
  return BASE58_RE.test(value.trim());
}

/** A token mint: base58 OR an EVM 0x-address, matching the backend's isValidMint. */
export function isPumpMint(value: string): boolean {
  const v = value.trim();
  return BASE58_RE.test(v) || EVM_RE.test(v);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Truncate an address to `head…tail` for a table cell. Short strings pass through. */
export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Format a multiplier as `2.5x`. Null (no call-price basis) renders as an em
 * dash, NOT `0x` — a missing multiplier is unknown, not a wipe, and showing 0x
 * would read as "this call went to zero".
 */
export function formatMultiplier(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return '—';
  // Trim to at most 2 decimals without trailing zeros: 2.5 -> "2.5x", 10 -> "10x".
  const rounded = Math.round(m * 100) / 100;
  return `${rounded}x`;
}

// formatMcap moved to utils/formatMcap.ts — the boot path (useWebSocket,
// RevivalBanner) needs it, and importing it from this module dragged all of
// this file's runtime code into the index chunk. Re-exported here so the lazy
// pumpfun/revival consumers keep their single import site.
export { formatMcap } from '../utils/formatMcap';

/** Format a SOL amount to a readable figure. Null -> em dash. */
export function formatSol(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  // Small trade sizes need precision; large ones don't. 4 sig figures reads well.
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

// ---------------------------------------------------------------------------
// User-login leaderboard (KEYED WITH THE OPERATOR'S OWN pump.fun SESSION COOKIE)
//
// A THIRD trust tier, above the keyed-callouts and keyless-profile surfaces: the
// leaderboard is fetched with the operator's own 30-day pump.fun session token
// (sent server-side as a cookie), so it is genuinely per-user and gated on a
// connected session. The token NEVER reaches the frontend — the console POSTs it
// once to the connect route and from then on only ever sees the status shape
// below, never the token. There is deliberately no client type that carries the
// token: nothing here should be able to hold, log, or render it.
// ---------------------------------------------------------------------------

/** The window a leaderboard is ranked over — 1D / 1W / 1M (no all-time board). */
export type PumpLeaderboardWindow = '1d' | '1w' | '1m';

/** The window switch's options, in display order. */
export const PUMP_LEADERBOARD_WINDOWS: readonly PumpLeaderboardWindow[] = ['1d', '1w', '1m'] as const;

/**
 * One ranked trader row, mirroring the backend's narrowed `/pnl-leaderboard` row.
 * `walletAddress` is what the Track button feeds into the tracked list, and it is
 * nullable on purpose: a row whose wallet fails validation still renders (with a
 * disabled Track) rather than being dropped. `xUsername` is the linked X handle,
 * rendered as an X link when present.
 */
export interface PumpLeaderboardEntry {
  rank: number | null;
  walletAddress: string | null;
  username: string | null;
  xUsername: string | null;
  pnlUsd: number | null;
}

/**
 * Connection status exactly as the STATUS route reports it — connected/expiry
 * only, NEVER the token. `needsReconnect` lets the backend say "a session exists
 * but is expired or was rejected upstream" without the frontend having to reason
 * about the raw expiry itself.
 */
export interface PumpConnectionStatus {
  connected: boolean;
  /** ISO timestamp the pump.fun JWT expires, when the backend can surface it. */
  expiresAt: string | null;
  needsReconnect: boolean;
}

/** The four states the connect UI branches on. `unknown` = status not yet known. */
export type PumpConnectionState = 'unknown' | 'disconnected' | 'connected' | 'reconnect';

export interface PumpConnectionSummary {
  state: PumpConnectionState;
  /** Whole days until expiry when known; a past/zero value collapses to `reconnect`. */
  daysLeft: number | null;
}

const DAY_MS = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First non-empty string among the candidate keys, else null. */
function pickStr(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/** First finite number among the candidate keys, else null. */
function pickNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Narrow the leaderboard response into rows, dropping-not-throwing per row the way
 * the backend client does. Accepts either a bare array or a `{ entries: [...] }`
 * envelope, since the wire shape is unverified.
 *
 * The backend already narrowed the upstream row to these exact keys, so the
 * spellings are read directly (a couple of legacy aliases stay for resilience).
 * The response arrives as a bare array (the route's sliced rows); an
 * `{ entries: [...] }` envelope is still accepted for safety. A wallet that fails
 * base58 is kept as null (the row still ranks) rather than smuggled into the
 * tracked list, where an invalid address would track-but-never-load.
 */
export function normalizePumpLeaderboard(parsed: unknown): PumpLeaderboardEntry[] {
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? (parsed.entries as unknown[])
      : [];
  const out: PumpLeaderboardEntry[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue; // one junk row must not blank the board
    const walletRaw = pickStr(row, ['walletAddress', 'wallet', 'address']);
    const walletAddress = walletRaw && isPumpWallet(walletRaw) ? walletRaw.trim() : null;
    out.push({
      rank: pickNum(row, ['rank']),
      walletAddress,
      username: pickStr(row, ['username', 'handle']),
      xUsername: pickStr(row, ['xUsername']),
      pnlUsd: pickNum(row, ['pnlUsd', 'pnl']),
    });
  }
  return out;
}

/** Days until the pump JWT expires; null when there is no readable timestamp. */
export function pumpDaysLeft(expiresAt: string | null, now: number = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - now) / DAY_MS);
}

/**
 * Collapse a raw status into the state the connect UI renders. Pure so the
 * branch table is unit-tested rather than discovered by clicking:
 *   - null status  -> `unknown` (caller shows a spinner, never a false "connect")
 *   - needsReconnect-> `reconnect` outright, whatever expiresAt says
 *   - not connected -> `disconnected` (show the connect panel)
 *   - connected     -> `connected`, unless the expiry is already in the past, in
 *                      which case it is a `reconnect` even though the flag lagged.
 */
export function describePumpConnection(
  status: PumpConnectionStatus | null,
  now: number = Date.now(),
): PumpConnectionSummary {
  if (status === null) return { state: 'unknown', daysLeft: null };
  if (status.needsReconnect) return { state: 'reconnect', daysLeft: null };
  if (!status.connected) return { state: 'disconnected', daysLeft: null };
  const daysLeft = pumpDaysLeft(status.expiresAt, now);
  if (daysLeft !== null && daysLeft <= 0) return { state: 'reconnect', daysLeft };
  return { state: 'connected', daysLeft };
}

/** Track-button state for a leaderboard row against the tracked-wallet set. */
export type LeaderboardTrackState = 'tracked' | 'trackable' | 'no-wallet';

/**
 * Decide how a row's Track button renders. A row with no usable wallet is
 * `no-wallet` (disabled, nothing to track); an already-tracked wallet is
 * `tracked` (disabled, like FOMO's "Tracked"); otherwise `trackable`.
 */
export function leaderboardTrackState(
  entry: PumpLeaderboardEntry,
  trackedAddresses: Set<string>,
): LeaderboardTrackState {
  if (!entry.walletAddress) return 'no-wallet';
  return trackedAddresses.has(entry.walletAddress) ? 'tracked' : 'trackable';
}

/** A trader's display label: @username, then a truncated wallet. */
export function leaderboardLabel(entry: PumpLeaderboardEntry): string {
  if (entry.username) return `@${entry.username}`;
  if (entry.walletAddress) return truncateAddress(entry.walletAddress);
  return 'Unknown trader';
}

/** Compact signed USD PnL: 1_234 -> "+$1.2K", -2_000_000 -> "-$2.0M". Null -> em dash. */
export function formatPnlUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '-';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export type TradeSide = 'buy' | 'sell' | 'unknown';

/**
 * Derive a swap's side for display. Reads the upstream `side` (BUY|SELL,
 * case-insensitive) rather than guessing from the legs — the backend already
 * resolved the coin leg by mint, so `side` is the authoritative direction, and a
 * missing/garbage value degrades to 'unknown' rather than defaulting to 'buy'
 * (defaulting would silently mislabel every unlabeled row as a purchase).
 */
export function deriveTradeSide(tx: PumpSwapTransaction): TradeSide {
  const side = tx.side?.trim().toUpperCase();
  if (side === 'BUY') return 'buy';
  if (side === 'SELL') return 'sell';
  return 'unknown';
}

/**
 * Collect the unique coin mints a wallet actually swapped, newest-first order
 * preserved, capped at `max`. This is what the deliberate PnL button POSTs: only
 * SWAP rows carry a tradable coin, and the cap mirrors the backend's
 * MAX_PNL_MINTS so a wallet with hundreds of trades cannot build a body the API
 * would 400 on.
 */
export function walletMintsFromTransactions(txs: PumpTransaction[], max = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tx of txs) {
    if (tx.type !== 'SWAP') continue;
    const mint = tx.token;
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    out.push(mint);
    if (out.length >= max) break;
  }
  return out;
}
