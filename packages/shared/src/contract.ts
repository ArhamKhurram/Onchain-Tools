// Contract address detection + trade-link building — shared by the backend
// ingestion pipeline and the browser Discord gateway / frontend. Moved verbatim
// from the previously-duplicated backend/src/utils/contract.ts,
// frontend/src/discord/contractDetect.ts, and frontend/src/utils/contractUrl.ts,
// which were byte-identical for these units. The platform/template types below
// are local shared copies of the ones in backend/src/discord/types.ts and
// frontend/src/types/index.ts (identical). See REFACTOR.md / IDEAS.md.

import type { ContractLinkTemplates } from './types.js';

export const SOL_ADDRESS_REGEX = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,48}(?![1-9A-HJ-NP-Za-km-z])/g;
export const EVM_ADDRESS_REGEX = /\b0x[a-fA-F0-9]{40}\b/g;

export interface ContractDetectionResult {
  hasContract: boolean;
  addresses: string[];
}

export function detectContractAddresses(content: string): ContractDetectionResult {
  const addresses: string[] = [];

  // Strip URLs so we don't match addresses embedded in links
  const stripped = content
    .replace(/https?:\/\/[^\s<>)]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  const evmMatches = stripped.match(EVM_ADDRESS_REGEX);
  if (evmMatches) {
    addresses.push(...evmMatches);
  }

  const solMatches = stripped.match(SOL_ADDRESS_REGEX);
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

export const REFERRALS = { axiom: 'danielref', padre: 'daniel_dev', gmgn: 'danieldev', bloom: 'daniel' };

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
