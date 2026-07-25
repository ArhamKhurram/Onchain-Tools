// Re-export shim: contract address detection now lives in @oct/shared (moved
// verbatim from the previously-duplicated backend + frontend copies).
export { detectContractAddresses } from '@oct/shared';
export type { ContractDetectionResult } from '@oct/shared';
