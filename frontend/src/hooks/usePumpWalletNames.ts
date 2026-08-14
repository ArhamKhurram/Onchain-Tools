import { useEffect, useReducer } from 'react';
import { pumpGet } from '../lib/pumpfunApi';
import type { PumpUser } from '../types/pumpfun';

// Resolve a tracked wallet's pump.fun display name so the list shows "slingoor"
// instead of the raw "5YRgrP…Uzij". The detail panel already resolves this per-wallet
// (usePumpWalletActivity → /wallet/:address); this hook does the same for the WHOLE
// tracked list up front, so the sidebar reads as names, not addresses.
//
// Resolution is cached in a MODULE-LEVEL map keyed by address, shared across every
// mount of every component using this hook: the /wallet/:address profile is KEYED
// (503 when PUMPFUN_API_KEY is unset) and immutable enough that re-fetching on each
// render — or each tab switch — would be pure waste. So each address is fetched at
// most once per page load; the list falls back to the truncated address until (and
// if) a name arrives.

/**
 * A resolution outcome. `null` means "resolved, but no name" (or the KEYED host is
 * off / errored) — it is still cached so we do NOT retry, matching the requirement to
 * fire one call per address, never N per render. A present string is the name.
 */
const nameCache = new Map<string, string | null>();
/** Addresses with a request in flight, so a re-render mid-fetch does not double-fire. */
const inFlight = new Set<string>();

/**
 * Given the tracked addresses, return a map of the ones whose name has resolved.
 * Callers render `names[address] ?? truncateAddress(address)`.
 *
 * @param addresses the wallets to resolve — order-insensitive; only newly-seen
 *   addresses trigger a fetch.
 */
export function usePumpWalletNames(addresses: string[]): Record<string, string> {
  // A cache hit lands outside React state (the module map), so a bump forces the
  // consuming component to re-read the map once a batch of names resolves.
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Join into a stable key so the effect only re-runs when the SET of addresses
  // changes, not on every render that passes a fresh array literal.
  const key = addresses.join(',');

  useEffect(() => {
    const toFetch = addresses.filter((a) => !nameCache.has(a) && !inFlight.has(a));
    if (toFetch.length === 0) return;

    let cancelled = false;
    for (const addr of toFetch) inFlight.add(addr);

    void Promise.all(
      toFetch.map(async (addr) => {
        const res = await pumpGet<PumpUser>(`/wallet/${addr}`);
        // Cache the outcome either way — a name, or null on no-name / disabled /
        // error — so this address is never re-requested this session.
        nameCache.set(addr, res.ok ? res.data?.displayName ?? res.data?.username ?? null : null);
        inFlight.delete(addr);
      }),
    ).then(() => {
      if (!cancelled) bump();
    });

    return () => {
      cancelled = true;
    };
    // `key` captures the address set; addresses is read fresh inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const names: Record<string, string> = {};
  for (const addr of addresses) {
    const resolved = nameCache.get(addr);
    if (resolved) names[addr] = resolved;
  }
  return names;
}
