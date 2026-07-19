import type { ContractEntry } from '../types';

/** Fields copied from a prior detection of the same token address. */
export type ContractMetadata = Pick<
  ContractEntry,
  | 'tokenName'
  | 'tokenSymbol'
  | 'tokenPair'
  | 'description'
  | 'fdvAtCall'
  | 'fdvAtCallDisplay'
  | 'liquidityUsd'
  | 'liquidityDisplay'
  | 'volumeUsd'
  | 'volumeDisplay'
  | 'priceUsd'
  | 'tokenAge'
  | 'enrichmentSource'
  | 'enrichedAt'
  | 'evmChain'
>;

export function hasContractMetadata(entry: ContractEntry): boolean {
  return !!(entry.tokenSymbol || entry.tokenName || entry.fdvAtCallDisplay);
}

/** Fill missing enrichment on a new row from an earlier row with the same address. */
export function hydrateContractFromCatalog(
  entry: ContractEntry,
  catalog: ContractEntry[],
): ContractEntry {
  const prior = catalog.find(
    (c) => c.address.toLowerCase() === entry.address.toLowerCase() && hasContractMetadata(c),
  );
  if (!prior) return entry;

  return {
    ...entry,
    tokenName: entry.tokenName ?? prior.tokenName,
    tokenSymbol: entry.tokenSymbol ?? prior.tokenSymbol,
    tokenPair: entry.tokenPair ?? prior.tokenPair,
    description: entry.description ?? prior.description,
    fdvAtCall: entry.fdvAtCall ?? prior.fdvAtCall,
    fdvAtCallDisplay: entry.fdvAtCallDisplay ?? prior.fdvAtCallDisplay,
    liquidityUsd: entry.liquidityUsd ?? prior.liquidityUsd,
    liquidityDisplay: entry.liquidityDisplay ?? prior.liquidityDisplay,
    volumeUsd: entry.volumeUsd ?? prior.volumeUsd,
    volumeDisplay: entry.volumeDisplay ?? prior.volumeDisplay,
    priceUsd: entry.priceUsd ?? prior.priceUsd,
    tokenAge: entry.tokenAge ?? prior.tokenAge,
    enrichmentSource: entry.enrichmentSource ?? prior.enrichmentSource,
    enrichedAt: entry.enrichedAt ?? prior.enrichedAt,
    evmChain: entry.evmChain ?? prior.evmChain,
  };
}

/** Merge server + local rows without wiping enrichment the DB omitted. */
export function mergeContractEntries(local: ContractEntry, server: ContractEntry): ContractEntry {
  return {
    ...local,
    ...server,
    tokenName: server.tokenName ?? local.tokenName,
    tokenSymbol: server.tokenSymbol ?? local.tokenSymbol,
    tokenPair: server.tokenPair ?? local.tokenPair,
    description: server.description ?? local.description,
    fdvAtCall: server.fdvAtCall ?? local.fdvAtCall,
    fdvAtCallDisplay: server.fdvAtCallDisplay ?? local.fdvAtCallDisplay,
    liquidityUsd: server.liquidityUsd ?? local.liquidityUsd,
    liquidityDisplay: server.liquidityDisplay ?? local.liquidityDisplay,
    volumeUsd: server.volumeUsd ?? local.volumeUsd,
    volumeDisplay: server.volumeDisplay ?? local.volumeDisplay,
    priceUsd: server.priceUsd ?? local.priceUsd,
    tokenAge: server.tokenAge ?? local.tokenAge,
    enrichmentSource: server.enrichmentSource ?? local.enrichmentSource,
    enrichedAt: server.enrichedAt ?? local.enrichedAt,
    evmChain: server.evmChain ?? local.evmChain,
    firstSeen: server.firstSeen ?? local.firstSeen,
  };
}
