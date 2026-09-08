// The JSON-RPC transport for the Flap watcher.
//
// ONE ENDPOINT SHAPE, TWO CHAINS. BNB reads from Pinax's JSON-RPC
// (`https://bsc.rpc.pinax.network/v1/<PINAX_API_KEY>`), where the key is a PATH
// segment, not a header. Robinhood is not indexed by Pinax and has no default
// endpoint, so its RPC URL is supplied entirely by env — the watcher for it
// only runs when that env is set (see poller.ts / config.ts).
//
// THE KEY IS IN THE URL, SO THE URL IS NEVER LOGGED. Every log line here names
// the chain and the method, never the endpoint — `redactRpcUrl` exists for the
// one place a URL must appear (a startup line) and masks everything after the
// host. Treat every response as untrusted: this returns typed values or null
// and never throws into the poll loop.

import type { FlapChain, RawLog } from './detect.js';

const FETCH_TIMEOUT_MS = 20_000;

/** eth_getLogs parameters (a single ≤100k-block window; the poller paginates). */
export interface GetLogsParams {
  fromBlock: number;
  toBlock: number;
  address: string;
  /** Topic filter: topic0, plus an optional factory-address OR-set at topic3. */
  topics: (string | string[] | null)[];
}

/** What the poller needs from a chain's RPC. Injected so the poller is testable. */
export interface FlapRpc {
  /** Latest block height, or null on failure. */
  blockNumber(): Promise<number | null>;
  /** Logs for one window, or null on failure (never a partial page). */
  getLogs(params: GetLogsParams): Promise<RawLog[] | null>;
  /** `eth_call` returning the raw hex result, or null on failure. */
  call(to: string, data: string): Promise<string | null>;
}

/** Mask an RPC URL for logging: keep protocol + host, drop the key-bearing path. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '<redacted>';
  }
}

/** A safe integer from a hex quantity string (`0x…`), or null. */
function hexToInt(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(s)) return null;
  const n = Number.parseInt(s, 16);
  return Number.isSafeInteger(n) ? n : null;
}

/** The HTTP implementation. `label` is the chain, used only for log lines. */
export class HttpFlapRpc implements FlapRpc {
  private id = 0;

  constructor(
    private readonly url: string,
    private readonly label: FlapChain,
  ) {}

  private async rpc<T>(method: string, params: unknown[]): Promise<T | null> {
    this.id += 1;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.id, method, params }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        // No URL — it carries the Pinax key. Chain + method + status only.
        console.warn(`[Flap] ${this.label} ${method} HTTP ${res.status}`);
        return null;
      }
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error) {
        console.warn(`[Flap] ${this.label} ${method} error: ${json.error.message ?? 'unknown'}`);
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      console.warn(`[Flap] ${this.label} ${method} request failed: ${(err as Error).message}`);
      return null;
    }
  }

  async blockNumber(): Promise<number | null> {
    return hexToInt(await this.rpc<string>('eth_blockNumber', []));
  }

  async getLogs(params: GetLogsParams): Promise<RawLog[] | null> {
    const result = await this.rpc<unknown>('eth_getLogs', [
      {
        fromBlock: `0x${params.fromBlock.toString(16)}`,
        toBlock: `0x${params.toBlock.toString(16)}`,
        address: params.address,
        topics: params.topics,
      },
    ]);
    if (result === null) return null;
    // A well-behaved node returns an array; anything else is treated as "no
    // logs" rather than trusted, so a hostile shape cannot crash the poller.
    return Array.isArray(result) ? (result as RawLog[]) : [];
  }

  async call(to: string, data: string): Promise<string | null> {
    const result = await this.rpc<string>('eth_call', [{ to, data }, 'latest']);
    return typeof result === 'string' ? result : null;
  }
}
