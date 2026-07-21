import {
  buildAuthQuery,
  buildSignatureMessage,
  detectAlgorithm,
  signMessage,
} from './gmgnSigner.js';

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
      needsPrivateKey?: boolean;
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

function normalizePrivateKeyPem(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function missingKeyResult<T>(): GmgnResult<T> {
  return {
    ok: false,
    error: 'Portfolio requires GMGN_API_KEY on server.',
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
  const needsPrivateKey =
    code === 40101611 ||
    String(apiError).toLowerCase().includes('private') ||
    String(apiError).toLowerCase().includes('signature');

  return {
    ok: false,
    error: String(apiError),
    code: typeof code === 'number' ? code : undefined,
    needsPrivateKey,
    gmgnConfigured: true,
  };
}

async function gmgnRequest<T>(
  subPath: string,
  queryExtra: Record<string, string | number | string[]>,
  signed: boolean,
): Promise<GmgnResult<T>> {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) return missingKeyResult<T>();

  const { timestamp, client_id } = buildAuthQuery();
  const query: Record<string, string | number | string[]> = { ...queryExtra, timestamp, client_id };
  const body = '';

  const headers: Record<string, string> = {
    'X-APIKEY': apiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'oct-backend/1.0',
  };

  if (signed) {
    const privateKeyPem = normalizePrivateKeyPem(process.env.GMGN_PRIVATE_KEY);
    if (!privateKeyPem) {
      return {
        ok: false,
        error: 'Holdings require GMGN_PRIVATE_KEY on server.',
        needsPrivateKey: true,
        gmgnConfigured: true,
      };
    }
    try {
      const message = buildSignatureMessage(subPath, query, body, timestamp);
      const signature = signMessage(message, privateKeyPem, detectAlgorithm(privateKeyPem));
      headers['X-Signature'] = signature;
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        needsPrivateKey: true,
        gmgnConfigured: true,
      };
    }
  }

  const url = buildUrl(subPath, query);

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
      console.error(`[GMGN] ${subPath} HTTP ${res.status} code=${json.code} error=${json.error ?? json.message}`);
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
}

/** API-key-only GET (stats, activity, token info). */
export async function gmgnGet<T>(
  subPath: string,
  queryExtra: Record<string, string | number | string[]>,
): Promise<GmgnResult<T>> {
  return gmgnRequest<T>(subPath, queryExtra, false);
}

/** Signed GET (holdings). Requires GMGN_PRIVATE_KEY. */
export async function gmgnSignedGet<T>(
  subPath: string,
  queryExtra: Record<string, string | number | string[]>,
): Promise<GmgnResult<T>> {
  return gmgnRequest<T>(subPath, queryExtra, true);
}

/** Legacy helper for token enrichment — returns null on failure. */
export async function gmgnGetLegacy<T>(
  subPath: string,
  queryExtra: Record<string, string | number>,
): Promise<T | null> {
  const result = await gmgnGet<T>(subPath, queryExtra);
  return result.ok ? result.data : null;
}
