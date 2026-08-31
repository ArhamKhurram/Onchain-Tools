// Pure mappers: a raw j7tracker event `data` payload → OCT's existing WS frame
// shapes. These are the unit-test targets (test/j7Mappers.test.ts) — no I/O, no
// socket, no clock beyond Date.parse. Everything upstream (client.ts, events.ts)
// funnels the untrusted `data` object through here and gets back either a
// fully-narrowed OCT payload or null, exactly as pumpfun/calloutFeedClient.ts
// narrows the old pump firehose.
//
// WHY j7 at all: fomo.family and pump.fun's callout firehose both went dark, so
// the j7tracker relay is the replacement upstream. Its two data events map
// one-for-one onto frames the console already renders — `pump_callout` (the KOL
// callout feed) and `fomo_trade` (per-trader activity) — so we deliberately
// reuse those frame types rather than invent new ones. The only additions are
// fields the OLD upstreams never carried and j7 recovers: `maxMultiplier` on a
// callout and the trade `timestamp`/`network`/`venue`. They ride as additive
// properties the console currently ignores (its handlers spread known keys), so
// no frontend WS type changes.

// ---------------------------------------------------------------------------
// Output shapes — one-for-one with the console's frame contracts.
//   pump_callout → frontend/src/types/pumpfun.ts  PumpCalloutEvent
//   fomo_trade   → frontend/src/types/fomo.ts     FomoTradeEvent
// The nullable fields stay nullable; the three keys OCT keys off on a callout
// (calloutId, callerAddress, coinMint) are non-null because a row missing any of
// them is dropped (returns null) rather than emitted.
// ---------------------------------------------------------------------------

/**
 * The `data` of a `pump_callout` WS frame. Mirrors the console's
 * `PumpCalloutEvent` plus `maxMultiplier` — the field pump.fun's firehose never
 * exposed and j7 recovers. `marketCapUsd` is the MC AT THE MOMENT OF THE CALL
 * (j7's `calledOutAtMcap`), the datum the whole callout feature turns on, not
 * the token's live cap.
 */
export interface J7CalloutData {
  calloutId: string;
  callerAddress: string;
  username: string | null;
  avatar: string | null;
  coinMint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  /** MC-at-call, USD (j7 `calledOutAtMcap`). */
  marketCapUsd: number | null;
  thesis: string | null;
  multiple: number | null;
  /** Epoch ms — coerced from j7's `timestamp` (ISO or ms). */
  createdAt: number | null;
  /** Peak multiple since the call. Additive; the console ignores it for now. */
  maxMultiplier: number | null;
}

/**
 * The `data` of a `fomo_trade` WS frame. Mirrors the console's `FomoTradeEvent`
 * plus three additive j7-only fields: the real trade `timestamp` (the console
 * otherwise stamps arrival time), the human `network` name, and a hard-coded
 * `venue`. `price`/`marketCap`/`equityUsd` came back null on real captures, so
 * every numeric here is nullable.
 */
export interface J7FomoTradeData {
  fomoUserId: string | null;
  fomoHandle: string | null;
  displayName: string | null;
  side: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  /** j7 carries no token name on a trade; OCT's own poller backfills from the catalog. */
  tokenName: string | null;
  marketCap: number | null;
  marketCapDisplay: string | null;
  networkId: number | null;
  usdValue: number | null;
  tradeId: string | null;
  /** ISO trade time from j7 (additive). */
  timestamp: string | null;
  /** Human chain name, e.g. "robinhood" (additive). */
  network: string | null;
  /** Hard-coded provenance for the console/store (additive). */
  venue: string;
}

// ---------------------------------------------------------------------------
// Narrowing helpers — same discipline as pumpfun/calloutFeedClient.ts: a value
// that isn't the right type degrades to null, it never throws.
// ---------------------------------------------------------------------------

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
 * Coerce a j7 timestamp to epoch ms. j7 sends ISO strings on fomo trades and we
 * accept either form on a callout: a finite number is taken as ms already, an
 * ISO/parseable string is `Date.parse`d, anything else is null. Kept lenient on
 * purpose — a missing timestamp must cost the row its `createdAt`, not the row.
 */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * Map a `pump_event` `kind:"callout"` payload to a `pump_callout` frame `data`.
 *
 * Returns null (never throws) when the row lacks one of the three keys OCT keys
 * off — `calloutId` (dedup), `author.wallet` (the caller match key), or
 * `token.address` (the coin) — mirroring pumpfun/calloutFeedClient's
 * parseRecentCallout. A `kind:"reply"` payload (its `calledOutAtMcap`/multiplier
 * are null and it hangs off `data.parent`) is not the caller's concern — the
 * router only ever hands us callouts — but this still tolerates one without
 * throwing, so the router's filter is belt-and-braces.
 */
export function mapCallout(raw: unknown): J7CalloutData | null {
  if (!isRecord(raw)) return null;
  const author = isRecord(raw.author) ? raw.author : {};
  const token = isRecord(raw.token) ? raw.token : {};

  const calloutId = str(raw.calloutId);
  const callerAddress = str(author.wallet);
  const coinMint = str(token.address);
  if (!calloutId || !callerAddress || !coinMint) return null;

  return {
    calloutId,
    callerAddress,
    username: str(author.username),
    avatar: str(author.avatar),
    coinMint,
    symbol: str(token.symbol),
    name: str(token.name),
    image: str(token.tokenImageUrl),
    // MC-at-call, NOT token.marketCapUsd (the live cap) — the recovered datum.
    marketCapUsd: num(raw.calledOutAtMcap),
    thesis: str(raw.text),
    multiple: num(raw.multiple),
    createdAt: toEpochMs(raw.timestamp),
    maxMultiplier: num(raw.maxMultiplier),
  };
}

/**
 * Map a `fomo_event` `kind:"trade"` payload to a `fomo_trade` frame `data`.
 *
 * Returns null (never throws) when there is no trade id — that is the dedup key
 * that guards j7's batched ~30s re-sends, so a trade without it can't be
 * emitted safely. `tradeId` is preferred, falling back to the row `id`. Every
 * numeric degrades to null (real captures had null price/marketCap/equityUsd).
 */
export function mapFomoTrade(raw: unknown): J7FomoTradeData | null {
  if (!isRecord(raw)) return null;
  const token = isRecord(raw.token) ? raw.token : {};

  const tradeId = str(raw.tradeId) ?? str(raw.id);
  if (!tradeId) return null;

  return {
    fomoUserId: str(raw.userId),
    fomoHandle: str(raw.userHandle),
    displayName: str(raw.displayName),
    side: str(raw.side),
    tokenAddress: str(token.address),
    tokenSymbol: str(token.symbol),
    tokenName: null,
    marketCap: num(raw.marketCap),
    marketCapDisplay: null,
    networkId: num(token.networkId),
    usdValue: num(raw.usdAmount),
    tradeId,
    timestamp: str(raw.timestamp),
    network: str(token.network),
    venue: 'fomo.family',
  };
}
