// Types for the pump.fun "callouts" data layer (coin-communities.xyz).
//
// UNOFFICIAL API. Every shape below is reverse-engineered from live responses,
// not a published contract. coin-communities.xyz can add, rename or drop a field
// without notice, so client.ts narrows every response at runtime and treats a
// mismatch as an error rather than trusting these interfaces blindly. Only fields
// the recon actually observed are declared here — nothing speculative — and the
// nullable ones are the fields seen present on some rows and absent on others.

/**
 * A "callout": a trader's call/reply/position on a token inside its community.
 * This is the rich object returned by both the per-token and per-wallet callout
 * endpoints.
 *
 * `id` is the only field client.ts treats as mandatory — a row without one is
 * unusable and gets dropped — so every other field is nullable to reflect that a
 * shape change costs a field, not the whole list.
 */
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
  /** Token price at the moment of the call. */
  calloutPrice: number | null;
  /** Token market cap at the moment of the call. */
  calloutMarketCap: number | null;
  isSpam: boolean;
  isHarmful: boolean;
  userTwitterUrl: string | null;
  followerCount: number | null;
  replyCount: number | null;
  tokenAddress: string | null;
  walletAddress: string | null;
  /** Where the callout originated (e.g. the client that authored it). */
  source: string | null;
  deletedAt: string | null;
  deletedReason: string | null;
  /** Mentioned entities; opaque shape, passed through untouched. */
  mentions: unknown[];
}

/**
 * A trending-feed item. Leaner than a callout — the public feed carries token
 * and author identity for a small trending slice, not the full call metadata
 * (no multiplier, no call price/mcap). Do not confuse this with a firehose:
 * `/feed/public` is a curated slice.
 */
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

/**
 * A token's community summary. Returned by `GET /communities/{mint}` and, in a
 * possibly-abbreviated form, as the rows of `GET /communities/top`.
 *
 * `tokenAddress` is injected by the client for the single-community endpoint
 * (the mint is the path param, not part of the body) and read from the row for
 * the list endpoint; it is nullable because a `top` row may omit it. `community`
 * is the nested record the single-community response wraps — its internal shape
 * was not pinned down by recon, so it stays an opaque record.
 */
export interface PumpCommunity {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenImageUrl: string | null;
  chainId: number | null;
  postCount: number | null;
  memberCount: number | null;
  totalLikes: number | null;
  latestPostAt: string | null;
  /** Nested `community` object from the single-community endpoint; shape unconfirmed. */
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
// Wallet activity, PnL and balance (profile-api.pump.fun).
//
// SECOND HOST, SECOND CONTRACT. Everything below is served by
// profile-api.pump.fun, NOT coin-communities.xyz, and — verified live — is fully
// OPEN: no key, no cookie, no bearer. The shapes are still reverse-engineered and
// still narrowed at runtime; the only difference from the callouts layer is the
// base URL and the absence of a credential. The interfaces stay deliberately
// separate from the callout ones so the keyed and keyless worlds never blur.
// ---------------------------------------------------------------------------

/** Token metadata as it rides inside a swap leg or a transferred amount. */
export interface PumpTokenMeta {
  symbol: string | null;
  name: string | null;
  /** On-chain decimals; used to scale a raw `amount` into a human figure. */
  decimals: number | null;
  program: string | null;
  icon: string | null;
}

/**
 * One mint + amount pair, with its metadata. Shared by both swap legs
 * (`token_in`/`token_out`) and a transfer's `token_transferred` — the upstream
 * shape is identical, so one narrower serves all three. `amount` is the RAW
 * on-chain amount (pre-decimals); scale it with `metadata.decimals`.
 */
export interface PumpTokenLeg {
  amount: number | null;
  mint: string | null;
  metadata: PumpTokenMeta | null;
}

/**
 * A swap. `side` is the upstream `transaction_type` (BUY|SELL). For a BUY,
 * `token_out` is SOL and `token_in` is the coin; for a SELL the legs reverse.
 * The `token*`/`amount` fields are DERIVED conveniences: the non-SOL leg's mint,
 * symbol and decimal-scaled amount, resolved by mint (not by trusting `side`) so
 * the coin is identified even if the venue mislabels the direction.
 */
export interface PumpSwapTransaction {
  type: 'SWAP';
  txHash: string;
  blockTime: number | null;
  fee: number | null;
  /** BUY | SELL, verbatim from `transaction_type`. */
  side: string | null;
  tokenIn: PumpTokenLeg | null;
  tokenOut: PumpTokenLeg | null;
  solValue: number | null;
  /** Derived: the non-SOL leg's mint. */
  token: string | null;
  /** Derived: the non-SOL leg's symbol. */
  tokenSymbol: string | null;
  /** Derived: the non-SOL leg's amount, scaled by its decimals when known. */
  amount: number | null;
}

/**
 * A transfer or a creator-fee claim — one shape, split by `type` so a UI can key
 * on the discriminant. `transactionType` is RECEIVE|SEND for a TRANSFER and
 * DISTRIBUTE_CREATOR_FEE for a FEE_CLAIM; `direction` is IN|OUT for both.
 */
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

/**
 * Any row whose `type` we do not model with dedicated fields — including
 * CREATE_COIN, which recon confirmed appears live but whose body was never
 * enumerated, AND any type pump.fun adds after this was written.
 *
 * THIS IS THE ROBUSTNESS HINGE. An unrecognised `type` is preserved here with its
 * `rawType` and the untouched `raw` row, NEVER dropped and NEVER thrown: dropping
 * a row silently understates a trader's activity, and throwing blanks the whole
 * page. Only the shared scalars are narrowed; a consumer that wants the specifics
 * of a future type reads `raw`.
 */
export interface PumpOtherTransaction {
  type: 'OTHER';
  /** The upstream `type` string as-received (e.g. 'CREATE_COIN'), or null. */
  rawType: string | null;
  txHash: string;
  blockTime: number | null;
  fee: number | null;
  transactionType: string | null;
  /** The full upstream row, untouched, for rendering an unmodeled type. */
  raw: Record<string, unknown>;
}

/**
 * A wallet-activity row: a discriminated union on `type`. The taxonomy is WIDER
 * than the documented SWAP/TRANSFER/FEE_CLAIM set — CREATE_COIN was seen live —
 * so `PumpOtherTransaction` is a first-class member, not an error path.
 */
export type PumpTransaction =
  | PumpSwapTransaction
  | PumpTransferTransaction
  | PumpOtherTransaction;

/** Cursor pagination envelope for the transactions list. */
export interface PumpPagination {
  hasMore: boolean;
  /** Pass back as `?cursor=` to fetch the next page; null on the last page. */
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

/**
 * Per-token realized/unrealized PnL for a wallet, from the batch endpoint.
 *
 * EVERY FIGURE MAY BE NULL: the batch echoes back a row for each mint asked, and
 * for a mint the wallet never traded the numeric fields come back null rather
 * than absent. `mint` is the one hard requirement (it keys the row); the rest
 * degrade. `feeDetail` is an opaque vendor breakdown, passed through untouched.
 */
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

/**
 * A wallet's balance/holdings summary. Its internal shape was NOT pinned down by
 * recon — the endpoint 200s with a holdings summary object whose fields were not
 * enumerated — so, like `PumpCommunity.community`, it is passed through as an
 * opaque record rather than modeled with fields we have not verified. The client
 * asserts only that it is an object.
 */
export type PumpBalanceSummary = Record<string, unknown>;
