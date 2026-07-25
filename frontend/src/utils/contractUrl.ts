import type { ContractLinkTemplates } from '../types';

// Re-export shim: URL building now lives in @oct/shared (moved verbatim from the
// previously-duplicated backend + frontend copies). DEFAULT_LINK_TEMPLATES stays
// here — it is frontend-only.
export { buildContractUrl } from '@oct/shared';

export const DEFAULT_LINK_TEMPLATES: ContractLinkTemplates = {
  evm: 'https://gmgn.ai/base/token/{address}',
  sol: 'https://axiom.trade/t/{address}?chain=sol',
  solPlatform: 'axiom',
  evmPlatform: 'gmgn',
};
