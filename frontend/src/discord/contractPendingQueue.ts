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

// rick-enrich hygiene. The browser gateway surfaces every embed-bearing message
// the account can see; unthrottled, busy servers turn this into hundreds of
// POSTs a minute, tripping the hosted /api rate limit and 429ing the whole
// console (holders drawer, contracts, everything). Callers gate to watched
// rooms; this layer adds once-per-message dedupe, a min-gap serial queue with a
// bounded backlog, and a cooldown when the backend says 429.
const enrichSeen = new Set<string>();
const ENRICH_SEEN_CAP = 500;
const ENRICH_MIN_GAP_MS = 400;
const ENRICH_MAX_PENDING = 10;
const ENRICH_429_COOLDOWN_MS = 60_000;
let enrichChain: Promise<void> = Promise.resolve();
let enrichLastAt = 0;
let enrichPending = 0;
let enrichPausedUntil = 0;

export async function tryRickEnrich(msg: {
  id?: string;
  channel_id: string;
  embeds?: unknown;
  content?: string;
  /** Message timestamp — anchors the global-first footer's relative age server-side. */
  timestamp?: string;
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
  if (Date.now() < enrichPausedUntil) return;
  if (msg.id) {
    if (enrichSeen.has(msg.id)) return;
    enrichSeen.add(msg.id);
    if (enrichSeen.size > ENRICH_SEEN_CAP) {
      const oldest = enrichSeen.values().next().value;
      if (oldest !== undefined) enrichSeen.delete(oldest);
    }
  }
  if (enrichPending >= ENRICH_MAX_PENDING) return;
  enrichPending++;
  enrichChain = enrichChain.then(() => sendRickEnrich(msg)).finally(() => {
    enrichPending--;
  });
  return enrichChain;
}

async function sendRickEnrich(msg: Parameters<typeof tryRickEnrich>[0]): Promise<void> {
  if (Date.now() < enrichPausedUntil) return;
  const wait = enrichLastAt + ENRICH_MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  enrichLastAt = Date.now();
  try {
    const res = await apiFetch(`${API_BASE}/contracts/rick-enrich`, {
      method: 'POST',
      body: JSON.stringify({
        channelId: msg.channel_id,
        embeds: msg.embeds,
        content: msg.content,
        timestamp: msg.timestamp,
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
    if (res.status === 429) {
      enrichPausedUntil = Date.now() + ENRICH_429_COOLDOWN_MS;
      return;
    }
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
