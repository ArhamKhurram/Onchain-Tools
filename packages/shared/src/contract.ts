// Contract address detection + trade-link building — shared by the backend
// ingestion pipeline and the browser Discord gateway / frontend. Moved verbatim
// from the previously-duplicated backend/src/utils/contract.ts,
// frontend/src/discord/contractDetect.ts, and frontend/src/utils/contractUrl.ts,
// which were byte-identical for these units. The platform/template types below
// are local shared copies of the ones in backend/src/discord/types.ts and
// frontend/src/types/index.ts (identical). See docs/architecture/tech-debt.md and docs/roadmap/.

import type { ContractLinkTemplates } from './types.js';

export const SOL_ADDRESS_REGEX = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,48}(?![1-9A-HJ-NP-Za-km-z])/g;
export const EVM_ADDRESS_REGEX = /\b0x[a-fA-F0-9]{40}\b/g;

export interface ContractDetectionResult {
  hasContract: boolean;
  addresses: string[];
}

const EVM_ADDRESS_EXACT = /^0x[a-fA-F0-9]{40}$/;

/** True for a bare EVM (0x + 40 hex) address — the only case-insensitive form. */
export function isEvmAddress(address: string): boolean {
  return EVM_ADDRESS_EXACT.test(address.trim());
}

/**
 * Canonical form of a contract address, for storage keys and comparisons.
 *
 * EVM addresses are hex and case-insensitive — the same token reaches us
 * lowercase from a caller's plain post and EIP-55 checksummed from a Rick
 * embed — so they are folded to lowercase. **Solana addresses are base58 and
 * case-SENSITIVE**: `abc…` and `Abc…` are different mints, so anything that is
 * not a bare EVM address is returned trimmed but otherwise untouched.
 */
export function normalizeContractAddress(address: string): string {
  const trimmed = address.trim();
  return EVM_ADDRESS_EXACT.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function detectContractAddresses(content: string): ContractDetectionResult {
  const addresses: string[] = [];

  // Strip URLs so we don't match addresses embedded in links
  const stripped = content
    .replace(/https?:\/\/[^\s<>)]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  const evmMatches = stripped.match(EVM_ADDRESS_REGEX);
  if (evmMatches) {
    // Canonicalise here — the earliest point every ingestion path shares (the
    // backend pipeline and the browser Discord gateway both land here). One
    // message can also carry the same address in two casings; keep one.
    for (const match of evmMatches) {
      const normalized = normalizeContractAddress(match);
      if (!addresses.includes(normalized)) addresses.push(normalized);
    }
  }

  // Blank out EVM hits before the base58 pass. Base58 omits 0/O/I/l, so an
  // EIP-55 checksummed address whose hex happens to avoid them (e.g.
  // 0x2Ec39B…cfffF) is itself a valid 41-char base58 run once its leading "0"
  // is dropped — and it is mixed case, so it cleared the Solana heuristics
  // below. One checksummed address therefore reported twice: the real EVM one
  // and a phantom "x2Ec39B…" mint, each with its own row and its own toast.
  const solScan = stripped.replace(EVM_ADDRESS_REGEX, ' ');

  const solMatches = solScan.match(SOL_ADDRESS_REGEX);
  if (solMatches) {
    for (const match of solMatches) {
      if (match.length >= 32 && !addresses.includes(match)) {
        const hasNumbers = /\d/.test(match);
        const hasMixedCase = /[a-z]/.test(match) && /[A-Z]/.test(match);
        if (hasNumbers && hasMixedCase && match.length >= 40) {
          addresses.push(match);
        }
      }
    }
  }

  return {
    hasContract: addresses.length > 0,
    addresses,
  };
}

export const REFERRALS = { axiom: 'xpertalt', padre: 'xpertisback', gmgn: 'xpert', bloom: '9S8HSYE56E' };

export function getPresetTemplate(platform: string, chain: 'sol' | 'evm', evmChain?: string): string {
  const evmSlug = evmChain || 'base';
  switch (platform) {
    case 'axiom':
      return `https://axiom.trade/t/{address}/@${REFERRALS.axiom}?chain=sol`;
    case 'padre':
      return `https://trade.padre.gg/trade/solana/{address}?rk=${REFERRALS.padre}`;
    case 'bloom':
      return chain === 'sol'
        ? `https://t.me/BloomSolana_bot?start=ref_${REFERRALS.bloom}_ca_{address}`
        : `https://t.me/BloomEVMbot?start=ref_${REFERRALS.bloom}_ca_{address}`;
    case 'gmgn':
      return chain === 'sol'
        ? `https://gmgn.ai/sol/token/${REFERRALS.gmgn}_{address}`
        : `https://gmgn.ai/${evmSlug}/token/${REFERRALS.gmgn}_{address}`;
    default:
      return chain === 'sol'
        ? 'https://axiom.trade/t/{address}?chain=sol'
        : `https://gmgn.ai/${evmSlug}/token/{address}`;
  }
}

export function injectReferralIntoCustomTemplate(template: string): string {
  if (template.includes('axiom.trade')) {
    return template.replace('{address}', `{address}/@${REFERRALS.axiom}`);
  }
  if (template.includes('padre.gg')) {
    const sep = template.includes('?') ? '&' : '?';
    return `${template}${sep}rk=${REFERRALS.padre}`;
  }
  if (template.includes('gmgn.ai')) {
    return template.replace('{address}', `${REFERRALS.gmgn}_{address}`);
  }
  if (template.includes('BloomSolana_bot') || template.includes('BloomEVMbot')) {
    return template.replace('ref__ca_', `ref_${REFERRALS.bloom}_ca_`);
  }
  return template;
}

export function buildContractUrl(
  addr: string,
  config: ContractLinkTemplates,
  evmChain?: string,
): string {
  const isEvm = addr.startsWith('0x');
  const chain: 'sol' | 'evm' = isEvm ? 'evm' : 'sol';
  const platform = isEvm
    ? (config.evmPlatform ?? 'gmgn')
    : (config.solPlatform ?? 'axiom');

  let template: string;
  if (platform === 'custom') {
    let customTpl = isEvm ? config.evm : config.sol;
    if (isEvm && evmChain) {
      customTpl = customTpl.replace(/gmgn\.ai\/\w+\/token/, `gmgn.ai/${evmChain}/token`);
    }
    template = injectReferralIntoCustomTemplate(customTpl);
  } else {
    template = getPresetTemplate(platform, chain, evmChain);
  }

  return template.replace('{address}', addr);
}

// --- FOMO network id ↔ OCT chain mapping ----------------------------------
// FOMO identifies chains by numeric network id; OCT uses slugs ('sol', 'eth', …).
// Shared so the backend can resolve token metadata from a trade and the frontend
// can build explorer/chart links for the same trade.

export const FOMO_NETWORK_CHAIN_SLUGS: Record<number, string> = {
  1: 'eth',
  56: 'bsc',
  143: 'robinhood',
  8453: 'base',
  1399811149: 'sol',
};

/** OCT chain slug for a FOMO network id, or null when unsupported. */
export function chainSlugFromNetworkId(networkId: number | null | undefined): string | null {
  if (networkId == null) return null;
  return FOMO_NETWORK_CHAIN_SLUGS[networkId] ?? null;
}

/** 'sol' | 'evm' bucket for a FOMO network id (what buildContractUrl expects). */
export function chainKindFromNetworkId(networkId: number | null | undefined): 'sol' | 'evm' | null {
  const slug = chainSlugFromNetworkId(networkId);
  if (!slug) return null;
  return slug === 'sol' ? 'sol' : 'evm';
}

// --- Revival networks (GeckoTerminal network id ↔ OCT chain slug) ----------
// THE one place the revival subsystem's chain map lives. The revival detector
// reads candles from GeckoTerminal, which identifies chains by its own network
// id ('solana', 'bsc', 'robinhood'); OCT's contract log uses its own slugs
// ('sol', 'bsc', 'robinhood'). Shared so the backend can build the poller's
// universe and the frontend can build a chart link for a stored alert row.
//
// Adding a chain is a one-line change here PLUS verifying GeckoTerminal
// actually indexes it keylessly:
//   GET https://api.geckoterminal.com/api/v2/networks/{id}/tokens/{addr}/pools

export const REVIVAL_NETWORKS = ['solana', 'bsc', 'robinhood'] as const;

/** A GeckoTerminal network id the revival detector can run on. */
export type RevivalNetwork = (typeof REVIVAL_NETWORKS)[number];

/** OCT chain slug for each supported GeckoTerminal network id. */
export const REVIVAL_NETWORK_CHAIN_SLUGS: Record<RevivalNetwork, string> = {
  solana: 'sol',
  bsc: 'bsc',
  robinhood: 'robinhood',
};

/** Short display label per network (matches EVM_CHAIN_LABELS in the backend). */
export const REVIVAL_NETWORK_LABELS: Record<RevivalNetwork, string> = {
  solana: 'SOL',
  bsc: 'BNB',
  robinhood: 'HOOD',
};

/** OCT chain slug (or GT id) → GeckoTerminal network id. */
const CHAIN_SLUG_TO_REVIVAL_NETWORK: Record<string, RevivalNetwork> = {
  sol: 'solana',
  solana: 'solana',
  bsc: 'bsc',
  bnb: 'bsc',
  robinhood: 'robinhood',
  hood: 'robinhood',
};

export function isRevivalNetwork(value: string | null | undefined): value is RevivalNetwork {
  return value != null && (REVIVAL_NETWORKS as readonly string[]).includes(value);
}

/**
 * GeckoTerminal network id for a logged contract, or null when the chain is
 * unknown or unsupported (an EVM address whose chain hasn't resolved yet, or a
 * chain the revival detector doesn't watch). Unsupported is a no-op, never an
 * error — the poller simply skips those contracts.
 */
export function revivalNetworkForChain(
  chain: 'sol' | 'evm' | string | null | undefined,
  evmChain?: string | null,
): RevivalNetwork | null {
  if (chain === 'sol') return 'solana';
  const key = (chain === 'evm' ? evmChain : (evmChain ?? chain))?.toLowerCase();
  if (!key) return null;
  return CHAIN_SLUG_TO_REVIVAL_NETWORK[key] ?? null;
}

/** Display label for a stored alert's network value (unknown ids pass through). */
export function revivalNetworkLabel(network: string): string {
  return isRevivalNetwork(network) ? REVIVAL_NETWORK_LABELS[network] : network.toUpperCase();
}

/**
 * Trade/chart link for a revival alert. Wraps buildContractUrl with the right
 * EVM chain slug so a BNB or Robinhood revival opens on ITS chain instead of
 * the template's default (which is Base). Solana passes through untouched —
 * buildContractUrl already routes base58 addresses to the Solana template.
 */
export function buildRevivalContractUrl(
  mint: string,
  network: string | null | undefined,
  config: ContractLinkTemplates,
): string {
  const gt = isRevivalNetwork(network) ? network : null;
  const evmChain = gt && gt !== 'solana' ? REVIVAL_NETWORK_CHAIN_SLUGS[gt] : undefined;
  return buildContractUrl(mint, config, evmChain);
}
