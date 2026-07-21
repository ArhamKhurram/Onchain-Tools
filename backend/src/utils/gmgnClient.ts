import { randomUUID } from 'crypto';

const GMGN_HOST = 'https://openapi.gmgn.ai';

type GmgnApiResponse<T> = {
  code: number;
  data: T;
  error?: string;
  message?: string;
};

function buildAuthQuery(): { timestamp: number; client_id: string } {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  };
}

function buildUrl(subPath: string, query: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  return `${GMGN_HOST}${subPath}?${params.toString()}`;
}

export async function gmgnGet<T>(
  subPath: string,
  queryExtra: Record<string, string | number>,
): Promise<T | null> {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) return null;

  const { timestamp, client_id } = buildAuthQuery();
  const url = buildUrl(subPath, { ...queryExtra, timestamp, client_id });

  try {
    const res = await fetch(url, {
      headers: {
        'X-APIKEY': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'oct-backend/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[GMGN] ${subPath} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json() as GmgnApiResponse<T>;
    if (json.code !== 0) {
      console.error(`[GMGN] ${subPath} code=${json.code} error=${json.error ?? json.message ?? 'unknown'}`);
      return null;
    }
    return json.data;
  } catch (err) {
    console.error('[GMGN] request failed:', (err as Error).message);
    return null;
  }
}
