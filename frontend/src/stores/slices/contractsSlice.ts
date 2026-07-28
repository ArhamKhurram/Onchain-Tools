import type { StateCreator } from 'zustand';
import type { ContractEntry } from '../../types';
import type { AppState } from '../appStore';
import { isDemoMode, createDemoOverrides } from '../../demo/demoStore';
import { hydrateContractFromCatalog } from '../../utils/contractMetadata';
import { resolvePendingEnrichment } from '../../discord/contractPendingQueue';
import { apiFetch, API_BASE, MAX_CONTRACTS, mergeContractLists, deriveAddressChains } from '../appStore.helpers';

export interface ContractsSlice {
  contracts: ContractEntry[];
  // Maps a lowercased contract address to its resolved EVM chain slug, so a
  // message's trade link can be corrected once the chain is known (e.g. from a
  // Rick follow-up or the API backfill), even if the address was posted bare.
  addressChains: Record<string, string>;

  addContract: (entry: ContractEntry, opts?: { skipCatalogHydrate?: boolean }) => void;
  persistContract: (entry: ContractEntry) => Promise<void>;
  updateContractChain: (address: string, evmChain: string) => void;
  enrichContract: (entry: ContractEntry) => void;
  deleteContract: (messageId: string, address: string) => Promise<void>;
  deleteAllContracts: () => Promise<void>;
  fetchContracts: () => Promise<void>;
}

export const createContractsSlice: StateCreator<AppState, [], [], ContractsSlice> = (set, get) => {
  const demo = isDemoMode ? createDemoOverrides(set as any, get as any) : null;

  return {
    contracts: [],
    addressChains: {},

    addContract: (entry, opts) => {
      set((state) => {
        const hydrated = opts?.skipCatalogHydrate
          ? entry
          : hydrateContractFromCatalog(entry, state.contracts);
        const updated = [hydrated, ...state.contracts];
        if (updated.length > MAX_CONTRACTS) updated.length = MAX_CONTRACTS;
        if (hydrated.chain === 'evm' && hydrated.evmChain) {
          const key = hydrated.address.toLowerCase();
          if (state.addressChains[key] !== hydrated.evmChain) {
            return { contracts: updated, addressChains: { ...state.addressChains, [key]: hydrated.evmChain } };
          }
        }
        return { contracts: updated };
      });
    },

    persistContract: async (entry) => {
      if (demo) return;
      try {
        await apiFetch(`${API_BASE}/contracts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
      } catch (err) {
        console.warn('[Store] Failed to persist contract:', err);
      }
    },

    updateContractChain: (address, evmChain) => {
      const key = address.toLowerCase();
      set((state) => ({
        contracts: state.contracts.map((c) =>
          c.address.toLowerCase() === key && c.chain === 'evm' ? { ...c, evmChain } : c,
        ),
        addressChains: { ...state.addressChains, [key]: evmChain },
      }));
    },

    enrichContract: (entry) => {
      resolvePendingEnrichment(entry);
      const key = entry.address.toLowerCase();
      // A Rick embed is the call itself, so it may replace an MC@call that a
      // Dex/GMGN fallback recorded first. Every other source only fills a gap.
      const rickWins = entry.enrichmentSource === 'rick';
      const metadataOnly = (c: ContractEntry): Partial<ContractEntry> => ({
        tokenName: c.tokenName ?? entry.tokenName,
        tokenSymbol: c.tokenSymbol ?? entry.tokenSymbol,
        tokenPair: c.tokenPair ?? entry.tokenPair,
        description: c.description ?? entry.description,
        evmChain: c.evmChain ?? entry.evmChain,
        enrichmentSource: c.enrichmentSource ?? entry.enrichmentSource,
        enrichedAt: entry.enrichedAt ?? c.enrichedAt,
      });

      set((state) => ({
        contracts: state.contracts.map((c) => {
          if (c.address.toLowerCase() !== key) return c;
          if (entry.messageId && c.messageId !== entry.messageId) {
            return { ...c, ...metadataOnly(c) };
          }
          return {
            ...c,
            tokenName: entry.tokenName ?? c.tokenName,
            tokenSymbol: entry.tokenSymbol ?? c.tokenSymbol,
            tokenPair: entry.tokenPair ?? c.tokenPair,
            description: entry.description ?? c.description,
            fdvAtCall: rickWins ? entry.fdvAtCall ?? c.fdvAtCall : c.fdvAtCall ?? entry.fdvAtCall,
            fdvAtCallDisplay: rickWins
              ? entry.fdvAtCallDisplay ?? c.fdvAtCallDisplay
              : c.fdvAtCallDisplay ?? entry.fdvAtCallDisplay,
            liquidityUsd: entry.liquidityUsd ?? c.liquidityUsd,
            liquidityDisplay: entry.liquidityDisplay ?? c.liquidityDisplay,
            volumeUsd: entry.volumeUsd ?? c.volumeUsd,
            volumeDisplay: entry.volumeDisplay ?? c.volumeDisplay,
            priceUsd: entry.priceUsd ?? c.priceUsd,
            tokenAge: entry.tokenAge ?? c.tokenAge,
            enrichmentSource: entry.enrichmentSource ?? c.enrichmentSource,
            enrichedAt: entry.enrichedAt ?? c.enrichedAt,
            evmChain: entry.evmChain ?? c.evmChain,
          };
        }),
        addressChains: entry.evmChain
          ? { ...state.addressChains, [key]: entry.evmChain }
          : state.addressChains,
      }));
    },

    deleteContract: async (messageId, address) => {
      if (demo) return demo.deleteContract(messageId, address);
      try {
        const res = await apiFetch(`${API_BASE}/contracts/${messageId}/${encodeURIComponent(address)}`, { method: 'DELETE' });
        if (!res.ok) return;
        set((state) => ({
          contracts: state.contracts.filter((c) => !(c.messageId === messageId && c.address === address)),
        }));
      } catch (err) {
        console.error('[Store] Failed to delete contract:', err);
      }
    },

    deleteAllContracts: async () => {
      if (demo) return demo.deleteAllContracts();
      try {
        const res = await apiFetch(`${API_BASE}/contracts`, { method: 'DELETE' });
        if (!res.ok) return;
        set({ contracts: [] });
      } catch (err) {
        console.error('[Store] Failed to delete all contracts:', err);
      }
    },

    fetchContracts: async () => {
      if (demo) return demo.fetchContracts();
      try {
        const res = await apiFetch(`${API_BASE}/contracts`);
        if (!res.ok) {
          console.error('[Store] Failed to fetch contracts:', res.status, await res.text().catch(() => ''));
          return;
        }
        const contracts: ContractEntry[] = await res.json();
        if (!Array.isArray(contracts)) {
          console.error('[Store] Unexpected contracts payload:', contracts);
          return;
        }
        set((state) => {
          const merged = mergeContractLists(state.contracts, contracts);
          return { contracts: merged, addressChains: deriveAddressChains(merged) };
        });
      } catch (err) {
        console.error('[Store] Failed to fetch contracts:', err);
      }
    },
  };
};
