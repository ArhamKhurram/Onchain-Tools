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
