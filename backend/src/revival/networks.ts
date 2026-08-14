/**
 * Which chains the revival poller watches, and how OCT's contract-log chain
 * slugs map onto GeckoTerminal network ids.
 *
 * The MAP itself lives in @oct/shared (`revivalNetworkForChain`) so the
 * frontend can resolve a stored alert's network to a chart link with the same
 * table. This module owns only the backend-side question: which of those
 * networks are switched ON right now.
 *
 * `OCT_REVIVAL_NETWORKS` (with the usual `TRENCHCORD_` fallback) is a
 * comma-separated list of GeckoTerminal network ids — e.g.
 *   OCT_REVIVAL_NETWORKS=solana
 * turns the multi-chain universe back into the Solana-only one without a
 * deploy. Unknown ids are ignored with a warning rather than throwing; an
 * empty/garbage list falls back to the default set.
 */

import { REVIVAL_NETWORKS, isRevivalNetwork, type RevivalNetwork } from '@oct/shared';

export const DEFAULT_REVIVAL_NETWORKS: readonly RevivalNetwork[] = REVIVAL_NETWORKS;

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

/**
 * Enabled GeckoTerminal network ids, in the configured order. Re-read on each
 * call (cheap, and keeps tests from needing a reset hook).
 */
export function resolveRevivalNetworks(): RevivalNetwork[] {
  return parseRevivalNetworks(envFlag('REVIVAL_NETWORKS'));
}

/** Pure parser for the env value — exported for tests. */
export function parseRevivalNetworks(raw: string | undefined | null): RevivalNetwork[] {
  if (raw == null || raw.trim() === '') return [...DEFAULT_REVIVAL_NETWORKS];

  const out: RevivalNetwork[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim().toLowerCase();
    if (id === '') continue;
    if (!isRevivalNetwork(id)) {
      console.warn(`[Revival] Ignoring unsupported network id in OCT_REVIVAL_NETWORKS: ${id}`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : [...DEFAULT_REVIVAL_NETWORKS];
}
