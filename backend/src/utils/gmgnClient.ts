import { buildAuthQuery } from './gmgnSigner.js';
import { isGmgnRateLimited, markGmgnRateLimited, withGmgnLimit } from './gmgnLimiter.js';

const GMGN_HOST = 'https://openapi.gmgn.ai';

type GmgnApiResponse<T> = {
  code: number;
  data: T;
  error?: string;
  message?: string;
};

export type GmgnResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      code?: number;
      gmgnConfigured?: boolean;
    };

function buildUrl(subPath: string, query: Record<string, string | number | string[]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.set(key, String(value));
    }
  }
  return `${GMGN_HOST}${subPath}?${params.toString()}`;
}

function missingKeyResult<T>(): GmgnResult<T> {
  return {
    ok: false,
    error: 'GMGN_API_KEY not configured on server.',
    gmgnConfigured: false,
  };
}

function parseFailure<T>(
  subPath: string,
  status: number,
  json: GmgnApiResponse<T> | null,
): GmgnResult<T> {
  const code = json?.code;
  const apiError = json?.error ?? json?.message ?? `HTTP ${status}`;

  return {
    ok: false,
    error: String(apiError),
    code: typeof code === 'number' ? code : undefined,
    gmgnConfigured: true,
  };
}

async function gmgnRequest<T>(
  subPath: string,
  queryExtra: Record<string, string | number | string[]>,
): Promise<GmgnResult<T>> {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) return missingKeyResult<T>();

  const { timestamp, client_id } = buildAuthQuery();
  const query: Record<string, string | number | string[]> = { ...queryExtra, timestamp, client_id };

  const headers: Record<string, string> = {
    'X-APIKEY': apiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'oct-backend/1.0',
  };

  if (isGmgnRateLimited()) {
    return {
      ok: false,
      error: 'RATE_LIMIT_BANNED',
      code: 429,
      gmgnConfigured: true,
    };
  }

  const url = buildUrl(subPath, query);

  return withGmgnLimit(async () => {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      let json: GmgnApiResponse<T> | null = null;
      try {
        json = (await res.json()) as GmgnApiResponse<T>;
      } catch {
        return parseFailure(subPath, res.status, null);
      }

      if (!res.ok || json.code !== 0) {
        const errText = String(json.error ?? json.message ?? `HTTP ${res.status}`);
        console.error(`[GMGN] ${subPath} HTTP ${res.status} code=${json.code} error=${errText}`);
        markGmgnRateLimited(errText);
        return parseFailure(subPath, res.status, json);
      }

      return { ok: true, data: json.data };
    } catch (err) {
      console.error('[GMGN] request failed:', (err as Error).message);
      return {
        ok: false,
        error: (err as Error).message,
        gmgnConfigured: true,
      };
    }
  });
}

/** API-key-only GET (stats, activity, token info). */
export async function gmgnGet<T>(
  subPath: string,
  queryExtra: Record<string, string | number | string[]>,
): Promise<GmgnResult<T>> {
  return gmgnRequest<T>(subPath, queryExtra);
}

/** Legacy helper for token enrichment — returns null on failure. */
export async function gmgnGetLegacy<T>(
  subPath: string,
  queryExtra: Record<string, string | number>,
): Promise<T | null> {
  const result = await gmgnGet<T>(subPath, queryExtra);
  return result.ok ? result.data : null;
}
