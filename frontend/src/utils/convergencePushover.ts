import { getAccessToken } from '../lib/supabase';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

export interface ConvergencePushoverPayload {
  contractAddress: string;
  tokenSymbol?: string | null;
  traderName: string;
  channelName: string;
  evmChain?: string;
}

async function pushoverFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** Ask the backend to send a Pushover notification for a convergence hit. */
export async function notifyConvergencePushover(payload: ConvergencePushoverPayload): Promise<void> {
  try {
    await pushoverFetch(`${API_BASE}/pushover/signal-convergence`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch {
    // Non-blocking; in-app alert still fires.
  }
}
