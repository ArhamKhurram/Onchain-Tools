// Thin REST helpers over j7tracker's subscription API — add / remove / list the
// pump and fomo targets an account tracks. Bearer-authed with the same manual
// JWT the socket uses.
//
// The capability exists; nothing here runs on boot. Targets are managed
// operator-side on j7tracker today, and auto-subscribing on connect would fight
// that source of truth (and silently spend an account's 50-slot cap), so
// startJ7Consumer never calls these. They are the seam for a future OCT-driven
// "track this caller" control, unit-testable in isolation because the transport
// (`j7Fetch`) is a plain fetch wrapper.
//
// Every call narrows the response and throws a plain Error on any non-2xx /
// non-JSON body — callers decide whether a failed add is fatal. Caps are 50 each
// (enforced server-side); we surface the returned `limit` rather than hard-code it.

const J7_REST_BASE = 'https://nj.j7tracker.io/wallets/api';
const TIMEOUT_MS = 10_000;
const VENDOR_ERROR_TEXT_LIMIT = 300;

/** A narrowed `{ …_users: [], limit }` list response. */
export interface J7ListResult {
  targets: string[];
  limit: number | null;
}

async function j7Fetch(
  jwt: string,
  path: string,
  init: { method: 'GET' } | { method: 'POST'; body: unknown },
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${jwt}`,
  };
  let body: string | undefined;
  if (init.method === 'POST') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  let res: Response;
  try {
    res = await fetch(`${J7_REST_BASE}${path}`, {
      method: init.method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
    throw new Error(`j7 REST ${path} ${detail}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`j7 REST ${path} → HTTP ${res.status}: ${text.slice(0, VENDOR_ERROR_TEXT_LIMIT)}`);
  }
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`j7 REST ${path} returned a non-JSON body`);
  }
}

/**
 * Narrow a list response keyed by `pump_users` / `fomo_users`.
 *
 * j7 returns each tracked target as an OBJECT, not a string, and the identity
 * field differs by tracker: pump rows carry `username` (e.g. `"cupsey"`), fomo
 * rows carry `handle` (e.g. `"unipcs"`). We surface that identifier so the list
 * round-trips with what `addPumpTarget`/`addFomoTarget` accept. A plain-string
 * element is tolerated as a fallback in case the shape ever flattens.
 */
function extractList(raw: unknown, key: 'pump_users' | 'fomo_users'): J7ListResult {
  if (typeof raw !== 'object' || raw === null) return { targets: [], limit: null };
  const r = raw as Record<string, unknown>;
  const arr = Array.isArray(r[key]) ? (r[key] as unknown[]) : [];
  const idField = key === 'pump_users' ? 'username' : 'handle';
  const targets = arr
    .map((x) => {
      if (typeof x === 'string') return x;
      if (typeof x === 'object' && x !== null) {
        const id = (x as Record<string, unknown>)[idField];
        return typeof id === 'string' ? id : null;
      }
      return null;
    })
    .filter((x): x is string => typeof x === 'string' && x !== '');
  const limit = typeof r.limit === 'number' && Number.isFinite(r.limit) ? r.limit : null;
  return { targets, limit };
}

// --- pump ---

/** Track a pump caller (`target` is the caller identifier j7 expects). */
export async function addPumpTarget(jwt: string, target: string): Promise<void> {
  await j7Fetch(jwt, '/pump/add', { method: 'POST', body: { target } });
}

/** Stop tracking a pump caller. */
export async function removePumpTarget(jwt: string, target: string): Promise<void> {
  await j7Fetch(jwt, '/pump/remove', { method: 'POST', body: { target } });
}

/** The account's tracked pump callers plus the server-enforced cap. */
export async function listPumpTargets(jwt: string): Promise<J7ListResult> {
  return extractList(await j7Fetch(jwt, '/pump/list', { method: 'GET' }), 'pump_users');
}

// --- fomo ---

/** Track a fomo trader. */
export async function addFomoTarget(jwt: string, target: string): Promise<void> {
  await j7Fetch(jwt, '/fomo/add', { method: 'POST', body: { target } });
}

/** Stop tracking a fomo trader. */
export async function removeFomoTarget(jwt: string, target: string): Promise<void> {
  await j7Fetch(jwt, '/fomo/remove', { method: 'POST', body: { target } });
}

/** The account's tracked fomo traders plus the server-enforced cap. */
export async function listFomoTargets(jwt: string): Promise<J7ListResult> {
  return extractList(await j7Fetch(jwt, '/fomo/list', { method: 'GET' }), 'fomo_users');
}
