import type { ContractLinkTemplates } from '../types';

// Re-export shim: URL building now lives in @oct/shared (moved verbatim from the
// previously-duplicated backend + frontend copies). DEFAULT_LINK_TEMPLATES stays
// here — it is frontend-only.
export { buildContractUrl } from '@oct/shared';
// Revival alerts carry their own chain (GeckoTerminal network id), so their
// links go through the network-aware wrapper rather than buildContractUrl —
// otherwise a BNB/Robinhood revival opens on the EVM template's default chain.
export { buildRevivalContractUrl, revivalNetworkLabel } from '@oct/shared';

export const DEFAULT_LINK_TEMPLATES: ContractLinkTemplates = {
  evm: 'https://gmgn.ai/base/token/{address}',
  sol: 'https://axiom.trade/t/{address}?chain=sol',
  solPlatform: 'axiom',
  evmPlatform: 'gmgn',
};
