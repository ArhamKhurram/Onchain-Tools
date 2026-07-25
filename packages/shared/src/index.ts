// @oct/shared — code shared across the OCT workspaces (backend, frontend,
// fomo-worker). Currently: keyword matching. Contract detection + shared types
// migrate here in follow-up PRs (see REFACTOR.md / IDEAS.md).
export { matchKeywords } from './keyword.js';
export type { KeywordPattern, KeywordMatchMode } from './keyword.js';
export {
  SOL_ADDRESS_REGEX,
  EVM_ADDRESS_REGEX,
  detectContractAddresses,
  REFERRALS,
  getPresetTemplate,
  injectReferralIntoCustomTemplate,
  buildContractUrl,
} from './contract.js';
export type {
  ContractDetectionResult,
  ContractLinkTemplates,
  SolPlatform,
  EvmPlatform,
} from './contract.js';
