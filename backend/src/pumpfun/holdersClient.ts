// Top-holders board for one pump.fun coin.
//
// There is NO single "holders" endpoint on pump — the browser stitches the panel
// from three sources client-side, and this module reproduces the two that don't
// need a login:
//
//   1. The base list (owner wallet + balance + supply-%) is READ ON-CHAIN via
//      Helius: getTokenLargestAccounts gives the top token ACCOUNTS (ATAs),
//      getMultipleAccounts resolves each to its OWNER, and getTokenSupply gives
//      the denominator for supply-%. There is no pump API for this — it is chain
//      data — which is why every guess at a /holders REST path 404s.
//   2. Per-holder PnL is the KEYLESS `POST profile-api.pump.fun/pnl/coin/{mint}/
//      holders` with `{ holders: [wallet, ...] }` — the same open host the
//      activity/PnL routes use (verified live: 201, no key/cookie/bearer).
//
// Identity (name/handle) is pump's THIRD source (`/users/by-wallet/batch` on
// coin-communities, x-api-key). It is NOT wired here yet: its request/response
// shape is unverified and fanning out 20 single by-wallet calls per open is the
// shared-key rate-limit lever we already hit. So `enriched` is false and `name`
// is null — the board renders short wallets, honestly, until the batch shape is
// captured and added.
//
// Error discipline mirrors client.ts: a Helius/profile-api hiccup surfaces as a
// typed PumpfunError (mapped to HTTP by routes.ts), never a leaked undefined.

import { PumpfunRequestError, PumpfunContractError } from './client.js';
import type { PumpHolder, PumpHoldersResponse } from './types.js';

// profile-api.pump.fun is the same keyless host client.ts uses; kept as its own
// constant here so a holders path can never be sent to the keyed coin-communities
// base by accident.
const PROFILE_BASE = 'https://profile-api.pump.fun';

const TIMEOUT_MS = 12_000;
const VENDOR_ERROR_TEXT_LIMIT = 500;

// How many top holders to resolve. The largest-accounts RPC returns up to 20,
// which is the natural cap and matches the depth the FOMO holders board shows.
const HOLDER_LIMIT = 20;

/** True when the on-chain leg can run. Holders need Helius, NOT the pump key. */
export function isHoldersConfigured(): boolean {
  return Boolean(process.env.HELIUS_API_KEY?.trim());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
 * One Helius JSON-RPC call. Throws the pump taxonomy on any failure so the route
 * maps it like every other upstream fault. The endpoint label is a fixed method
 * name — the api-key rides in the URL and is NEVER part of an error string.
 */
async function heliusRpc<T>(method: string, params: unknown[]): Promise<T> {
  const key = process.env.HELIUS_API_KEY?.trim();
  // Guarded by isHoldersConfigured() at the route, but re-checked so this is
  // never called blind: a missing key is a config fault, not an upstream one.
  if (!key) throw new PumpfunRequestError(`helius:${method}`, 0, 'HELIUS_API_KEY not set');

  let res: Response;
  try {
    res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'oct', method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
    throw new PumpfunRequestError(`helius:${method}`, 0, detail);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new PumpfunRequestError(`helius:${method}`, res.status, text.slice(0, VENDOR_ERROR_TEXT_LIMIT));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PumpfunContractError(`helius:${method}`, 'body was not JSON');
  }
  if (!isRecord(json)) throw new PumpfunContractError(`helius:${method}`, 'response was not an object');
  if (isRecord(json.error)) {
    const msg = typeof json.error.message === 'string' ? json.error.message : 'RPC error';
    throw new PumpfunRequestError(`helius:${method}`, res.status, msg.slice(0, VENDOR_ERROR_TEXT_LIMIT));
  }
  return json.result as T;
}

interface OwnerBalance {
  owner: string;
  amount: number;
}

/**
 * The top owner wallets + balances for a mint, read on-chain. Largest-accounts
 * yields token accounts; getMultipleAccounts resolves each to its owner. Two of
 * the top accounts could share an owner, so balances are summed per owner and the
 * list re-sorted, keeping the true top holders even after a merge.
 */
async function fetchTopOwners(mint: string): Promise<OwnerBalance[]> {
  const largest = await heliusRpc<{ value?: unknown }>('getTokenLargestAccounts', [mint]);
  const rows = isRecord(largest) && Array.isArray(largest.value) ? largest.value : [];
  const accounts = rows
    .map((r) => (isRecord(r) ? (typeof r.address === 'string' ? r.address : null) : null))
    .filter((a): a is string => a !== null)
    .slice(0, HOLDER_LIMIT);
  if (accounts.length === 0) return [];

  const multi = await heliusRpc<{ value?: unknown }>('getMultipleAccounts', [
    accounts,
    { encoding: 'jsonParsed' },
  ]);
  const infos = isRecord(multi) && Array.isArray(multi.value) ? multi.value : [];

  // owner -> summed ui amount
  const byOwner = new Map<string, number>();
  for (const info of infos) {
    if (!isRecord(info)) continue;
    const data = isRecord(info.data) ? info.data : null;
    const parsed = data && isRecord(data.parsed) ? data.parsed : null;
    const inner = parsed && isRecord(parsed.info) ? parsed.info : null;
    if (!inner) continue;
    const owner = typeof inner.owner === 'string' ? inner.owner : null;
    const tokenAmount = isRecord(inner.tokenAmount) ? inner.tokenAmount : null;
    const uiAmount = tokenAmount ? num(tokenAmount.uiAmount) : null;
    if (!owner) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + (uiAmount ?? 0));
  }

  return [...byOwner.entries()]
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** Total token supply (ui-scaled) for the supply-% denominator. Null on absence. */
async function fetchSupply(mint: string): Promise<number | null> {
  const supply = await heliusRpc<{ value?: unknown }>('getTokenSupply', [mint]);
  const value = isRecord(supply) && isRecord(supply.value) ? supply.value : null;
  return value ? num(value.uiAmount) : null;
}

/** Pull a `{ ..., usd }` figure that may be nested under `.pnl`, else direct. */
function usdOf(v: unknown): number | null {
  if (!isRecord(v)) return null;
  if (isRecord(v.pnl)) return num(v.pnl.usd);
  return num(v.usd);
}

/** Pull a `{ ..., usd }` cost-basis figure (always nested under `.cost_basis`). */
function costBasisUsd(v: unknown): number | null {
  if (!isRecord(v) || !isRecord(v.cost_basis)) return null;
  return num(v.cost_basis.usd);
}

/**
 * Per-holder PnL from the keyless holders endpoint, as a wallet→row map. A
 * wallet the endpoint has no row for simply won't be in the map (the holder still
 * renders, PnL null). Never throws for a missing row — only for a broken call.
 */
async function fetchHoldersPnl(
  mint: string,
  wallets: string[],
): Promise<Map<string, { valueUsd: number | null; pnlUsd: number | null }>> {
  const path = `/pnl/coin/${encodeURIComponent(mint)}/holders`;
  let res: Response;
  try {
    res = await fetch(`${PROFILE_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ holders: wallets }),
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
    throw new PumpfunRequestError(path, 0, detail);
  }

  const text = await res.text();
  // The endpoint answers 201 on success (see client.ts note); any 2xx is ok.
  if (!res.ok) throw new PumpfunRequestError(path, res.status, text.slice(0, VENDOR_ERROR_TEXT_LIMIT));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PumpfunContractError(path, 'body was not JSON');
  }
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : null;
  if (!data) throw new PumpfunContractError(path, 'expected { data: [...] }');

  const map = new Map<string, { valueUsd: number | null; pnlUsd: number | null }>();
  for (const row of data) {
    if (!isRecord(row)) continue;
    const wallet = typeof row.wallet === 'string' ? row.wallet : null;
    if (!wallet) continue;
    const unrealizedPnl = usdOf(row.unrealized);
    const realizedPnl = usdOf(row.realized);
    const basis = costBasisUsd(row.unrealized);
    // Current position value = cost basis + unrealized PnL. Null when we have
    // neither piece (a fully-realized/exited holder has no unrealized block).
    const valueUsd = basis === null && unrealizedPnl === null ? null : (basis ?? 0) + (unrealizedPnl ?? 0);
    const pnlUsd =
      realizedPnl === null && unrealizedPnl === null ? null : (realizedPnl ?? 0) + (unrealizedPnl ?? 0);
    map.set(wallet, { valueUsd, pnlUsd });
  }
  return map;
}

/**
 * The assembled top-holders board for a coin. Runs the on-chain owner resolve and
 * the supply read together, then the PnL POST over the resolved owners. Any
 * upstream fault throws a typed PumpfunError; a partial (e.g. PnL row absent for
 * one owner) degrades that holder's figures to null rather than failing the board.
 */
export async function getTokenHolders(mint: string): Promise<PumpHoldersResponse> {
  const [owners, supply] = await Promise.all([fetchTopOwners(mint), fetchSupply(mint)]);

  if (owners.length === 0) {
    return { mint, holders: [], enriched: false };
  }

  const pnl = await fetchHoldersPnl(
    mint,
    owners.map((o) => o.owner),
  );

  const holders: PumpHolder[] = owners.map((o, i) => {
    const p = pnl.get(o.owner);
    return {
      rank: i + 1,
      wallet: o.owner,
      name: null, // identity enrichment not yet wired — see module header.
      amount: o.amount,
      supplyPct: supply && supply > 0 ? (o.amount / supply) * 100 : null,
      valueUsd: p?.valueUsd ?? null,
      pnlUsd: p?.pnlUsd ?? null,
    };
  });

  return { mint, holders, enriched: false };
}
