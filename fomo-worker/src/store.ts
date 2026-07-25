// Minimal Supabase REST access — no realtime/WebSocket dependency.

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )?.trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

function restHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function loadPersistedRefreshToken(): Promise<string | null> {
  const cfg = supabaseConfig();
  if (!cfg) return null;

  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/fomo_poll_state?select=refresh_token&id=eq.true`,
      { headers: restHeaders(cfg.key, { Accept: 'application/json' }) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ refresh_token?: string }>;
    const token = rows[0]?.refresh_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch (err) {
    console.warn('[FomoWorker] Could not load refresh token from Supabase:', (err as Error)?.message);
    return null;
  }
}

export async function persistRefreshToken(token: string): Promise<void> {
  const cfg = supabaseConfig();
  if (!cfg) return;

  await fetch(`${cfg.url}/rest/v1/fomo_poll_state?id=eq.true`, {
    method: 'PATCH',
    headers: restHeaders(cfg.key, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ refresh_token: token }),
  });
}
