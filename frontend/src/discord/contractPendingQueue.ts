import type { ContractEntry } from '../types';
import { useAppStore } from '../stores/appStore';
import { hasContractMetadata, hydrateContractFromCatalog } from '../utils/contractMetadata';
import { isHostedMode, getAccessToken } from '../lib/supabase';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

/** Max time to wait for a Rick embed before running fallbacks. */
const RICK_WAIT_MS = 30_000;

type Pending = {
  entry: ContractEntry;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

function pendingKey(entry: ContractEntry): string {
  return `${entry.messageId}:${entry.address.toLowerCase()}`;
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (isHostedMode) {
    const token = await getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(input, { ...init, headers, credentials: 'include' });
}

export function mergeEnrichmentIntoEntry(
  entry: ContractEntry,
  patch: Partial<ContractEntry>,
): ContractEntry {
  return {
    ...entry,
    tokenName: patch.tokenName ?? entry.tokenName,
    tokenSymbol: patch.tokenSymbol ?? entry.tokenSymbol,
    tokenPair: patch.tokenPair ?? entry.tokenPair,
    description: patch.description ?? entry.description,
    fdvAtCall: patch.fdvAtCall ?? entry.fdvAtCall,
    fdvAtCallDisplay: patch.fdvAtCallDisplay ?? entry.fdvAtCallDisplay,
    liquidityUsd: patch.liquidityUsd ?? entry.liquidityUsd,
    liquidityDisplay: patch.liquidityDisplay ?? entry.liquidityDisplay,
    volumeUsd: patch.volumeUsd ?? entry.volumeUsd,
    volumeDisplay: patch.volumeDisplay ?? entry.volumeDisplay,
    priceUsd: patch.priceUsd ?? entry.priceUsd,
    tokenAge: patch.tokenAge ?? entry.tokenAge,
    enrichmentSource: patch.enrichmentSource ?? entry.enrichmentSource,
    enrichedAt: patch.enrichedAt ?? entry.enrichedAt,
    evmChain: patch.evmChain ?? entry.evmChain,
  };
}

function publishContract(entry: ContractEntry, skipCatalogHydrate = false): void {
  const store = useAppStore.getState();
  store.addContract(entry, { skipCatalogHydrate });
  void store.persistContract(entry);
}

function flushPending(key: string, patch?: Partial<ContractEntry>): void {
  const item = pending.get(key);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(key);
  const enriched = patch ? mergeEnrichmentIntoEntry(item.entry, patch) : item.entry;
  publishContract(enriched, !patch);
}

/** Rick didn't reply in time — Dex, then catalog, then bare CA. */
async function finalizeAfterTimeout(key: string): Promise<void> {
  const item = pending.get(key);
  if (!item) return;

  const { entry } = item;

  try {
    const res = await apiFetch(`${API_BASE}/contracts/dex-enrich`, {
      method: 'POST',
      body: JSON.stringify({ address: entry.address, channelId: entry.channelId }),
    });
    if (res.ok) {
      const data = await res.json() as {
        applied?: boolean;
        entry?: ContractEntry;
        enrichment?: Partial<ContractEntry> & { address: string };
      };
      if (data.entry) {
        flushPending(key, data.entry);
        return;
      }
      if (data.enrichment) {
        const merged = mergeEnrichmentIntoEntry(entry, data.enrichment);
        if (hasContractMetadata(merged)) {
          flushPending(key, data.enrichment);
          return;
        }
      }
    }
  } catch {
    // fall through
  }

  const catalog = useAppStore.getState().contracts;
  const hydrated = hydrateContractFromCatalog(entry, catalog);
  if (hasContractMetadata(hydrated)) {
    flushPending(key, hydrated);
    return;
  }

  flushPending(key);
}

/** Hold every live scan until Rick enriches it or the wait window + fallbacks run. */
export function queueContractDetection(entry: ContractEntry): void {
  const key = pendingKey(entry);
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    void finalizeAfterTimeout(key);
  }, RICK_WAIT_MS);

  pending.set(key, { entry, timer });
}

/** Rick embed or WS enrichment — release matching pending rows. */
export function resolvePendingEnrichment(enriched: ContractEntry): void {
  const addr = enriched.address.toLowerCase();
  for (const [key, item] of [...pending.entries()]) {
    if (item.entry.address.toLowerCase() !== addr) continue;
    flushPending(key, enriched);
  }
}

export async function tryRickEnrich(msg: {
  channel_id: string;
  embeds?: unknown;
  content?: string;
  author?: { username?: string };
}): Promise<void> {
  if (!msg.embeds || !Array.isArray(msg.embeds) || msg.embeds.length === 0) return;
  try {
    const res = await apiFetch(`${API_BASE}/contracts/rick-enrich`, {
      method: 'POST',
      body: JSON.stringify({
        channelId: msg.channel_id,
        embeds: msg.embeds,
        content: msg.content,
        authorUsername: msg.author?.username,
      }),
    });
    if (!res.ok) return;
    const data = await res.json() as {
      applied?: boolean;
      entry?: ContractEntry;
      enrichment?: Partial<ContractEntry> & { address: string };
    };
    if (!data.applied) return;
    if (data.entry) {
      resolvePendingEnrichment(data.entry);
      return;
    }
    if (data.enrichment?.address) {
      resolvePendingEnrichment(data.enrichment as ContractEntry);
    }
  } catch {
    // non-fatal
  }
}
