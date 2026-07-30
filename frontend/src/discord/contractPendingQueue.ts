import type { ContractEntry } from '../types';
import { useAppStore } from '../stores/appStore';
import { isHostedMode, getAccessToken } from '../lib/supabase';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

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

/**
 * A scan detected by the browser Discord gateway. Shown immediately (same as
 * local/desktop mode) and logged to the backend right away — a contract's
 * visibility in the feed must never depend on how long enrichment takes.
 * Rick's reply (tryRickEnrich, below) and the backend's own Dex/GMGN fallback
 * (~8s after logging, if Rick hasn't already answered) enrich the row in
 * place afterward. addContract() dedupes by messageId+address, so this is
 * also safe to call from anywhere else that might see the same scan again
 * (e.g. the WS echo of this very POST reaching the client over /ws).
 */
export function queueContractDetection(entry: ContractEntry): void {
  const store = useAppStore.getState();
  store.addContract(entry);
  void store.persistContract(entry);
}

/** Apply a Rick embed's enrichment to the matching row, if the row is showing. */
function applyEnrichmentResponse(data: {
  entry?: ContractEntry;
  enrichment?: Partial<ContractEntry> & { address: string };
}): void {
  const patch = data.entry ?? data.enrichment;
  if (!patch) return;
  useAppStore.getState().enrichContract(patch as ContractEntry);
}

export async function tryRickEnrich(msg: {
  channel_id: string;
  embeds?: unknown;
  content?: string;
  author?: { username?: string };
  referenced_message?: {
    id?: string;
    content?: string;
    author?: { username?: string; global_name?: string | null };
  } | null;
  message_reference?: {
    message_id?: string;
  } | null;
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
        referencedMessage: msg.referenced_message
          ? {
              id: msg.referenced_message.id,
              content: msg.referenced_message.content,
              author: msg.referenced_message.author,
            }
          : undefined,
        messageReference: msg.message_reference
          ? { message_id: msg.message_reference.message_id }
          : undefined,
      }),
    });
    if (!res.ok) return;
    const data = await res.json() as {
      applied?: boolean;
      entry?: ContractEntry;
      enrichment?: Partial<ContractEntry> & { address: string };
    };
    if (!data.applied) return;
    applyEnrichmentResponse(data);
  } catch {
    // non-fatal
  }
}
