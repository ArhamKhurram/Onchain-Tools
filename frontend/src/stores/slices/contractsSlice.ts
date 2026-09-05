import type { StateCreator } from 'zustand';
import type { ContractEntry } from '../../types';
import type { AppState } from '../appStore';
import { hydrateContractFromCatalog } from '../../utils/contractMetadata';
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
  /** Fold a live `token_peak` frame into every row of that address. */
  updateTokenPeak: (address: string, peakMc: number, peakAt: string) => void;
  enrichContract: (entry: ContractEntry) => void;
  deleteContract: (messageId: string, address: string) => Promise<void>;
  deleteAllContracts: () => Promise<void>;
  fetchContracts: () => Promise<void>;
}

export const createContractsSlice: StateCreator<AppState, [], [], ContractsSlice> = (set) => {
  return {
    contracts: [],
    addressChains: {},

    addContract: (entry, opts) => {
      // A re-delivery of a call the backend has already logged (#368 suppresses
      // the row; ingest still broadcasts what logContract returns, flagged).
      // Drop it rather than folding it into the address's rescan group: it is
      // the SAME call arriving twice over the transport, not a second scan, so
      // counting it would put back into the "×N scans" badge exactly the
      // inflation #368 took out of the database. It carries the original
      // call's timestamp too, so admitting it would either float a stale row
      // to the top of the feed or, once the 2000-row cap has evicted the
      // original, resurrect an hours-old call as a live detection.
      if (entry.duplicate) return;

      set((state) => {
        // A scan can reach the store twice — the browser gateway adds it the
        // instant it's detected, and the backend echoes the same log back
        // over /ws (also needed for Telegram, whose detection never goes
        // through the client at all). Same messageId+address means same
        // scan; don't duplicate the row.
        const alreadyShown = state.contracts.some(
          (c) => c.messageId === entry.messageId && c.address.toLowerCase() === entry.address.toLowerCase(),
        );
        if (alreadyShown) return state;

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

    updateTokenPeak: (address, peakMc, peakAt) => {
      if (!(peakMc > 0)) return;
      const key = address.toLowerCase();
      set((state) => {
        // Peaks are a high-water mark: a frame can only ever raise the value a
        // row already shows (out-of-order delivery must not lower it).
        let changed = false;
        const contracts = state.contracts.map((c) => {
          if (c.address.toLowerCase() !== key) return c;
          if (c.peakMc != null && c.peakMc >= peakMc) return c;
          changed = true;
          return { ...c, peakMc, peakAt };
        });
        return changed ? { contracts } : state;
      });
    },

    enrichContract: (entry) => {
      const key = entry.address.toLowerCase();
      // A Rick embed is the call itself, so it may replace an MC@call that a
      // Dex/GMGN fallback recorded first. Every other source only fills a gap.
      const rickWins = entry.enrichmentSource === 'rick';
      // Global-first (Rick's cross-server footer) is token-level and
      // point-in-time: the EARLIEST known first call wins, and it applies to
      // every row of the address, not just the enriched message's row.
      const globalFirst = (c: ContractEntry): Partial<ContractEntry> => {
        const cHas = c.firstCallerName != null || c.firstCallMcapUsd != null || c.firstCallAt != null;
        const eHas = entry.firstCallerName != null || entry.firstCallMcapUsd != null || entry.firstCallAt != null;
        let useEntry = eHas;
        if (cHas && eHas) {
          const cAt = c.firstCallAt ? new Date(c.firstCallAt).getTime() : NaN;
          const eAt = entry.firstCallAt ? new Date(entry.firstCallAt).getTime() : NaN;
          useEntry = Number.isFinite(eAt) && (!Number.isFinite(cAt) || eAt < cAt);
        }
        const winner = useEntry ? entry : c;
        return {
          firstCallerName: winner.firstCallerName,
          firstCallMcapUsd: winner.firstCallMcapUsd,
          firstCallAt: winner.firstCallAt,
        };
      };
      const metadataOnly = (c: ContractEntry): Partial<ContractEntry> => ({
        tokenName: c.tokenName ?? entry.tokenName,
        tokenSymbol: c.tokenSymbol ?? entry.tokenSymbol,
        tokenPair: c.tokenPair ?? entry.tokenPair,
        description: c.description ?? entry.description,
        evmChain: c.evmChain ?? entry.evmChain,
        enrichmentSource: c.enrichmentSource ?? entry.enrichmentSource,
        enrichedAt: entry.enrichedAt ?? c.enrichedAt,
        ...globalFirst(c),
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
            ...globalFirst(c),
          };
        }),
        addressChains: entry.evmChain
          ? { ...state.addressChains, [key]: entry.evmChain }
          : state.addressChains,
      }));
    },

    deleteContract: async (messageId, address) => {
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
      try {
        const res = await apiFetch(`${API_BASE}/contracts`, { method: 'DELETE' });
        if (!res.ok) return;
        set({ contracts: [] });
      } catch (err) {
        console.error('[Store] Failed to delete all contracts:', err);
      }
    },

    fetchContracts: async () => {
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
