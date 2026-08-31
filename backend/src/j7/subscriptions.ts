// Thin REST helpers over j7tracker's subscription API — add / remove / list the
// pump and fomo targets an account tracks. Bearer-authed with the same manual
// JWT the socket uses.
//
// These are now driven on a timer: roster.ts reconciles the upstream target set
// to what OCT's users actually track (see that module's header). j7 remains the
// source of truth for what is subscribed; OCT is the source of truth for what
// SHOULD be, and the reconciler moves one toward the other.
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

/**
 * One tracked row with EVERY identifier it carries.
 *
 * The reconciler needs more than the display identifier: OCT's pump demand is
 * keyed by caller WALLET (`pump_tracked_callers.caller_address`) while j7 lists
 * a pump row by `username`, so diffing the two on one field alone would see
 * every target as both missing and unwanted, and churn the whole roster every
 * cycle. Carrying both identifiers is what makes the diff converge.
 */
export interface J7TargetRow {
  /** j7's own identifier for the row — what `/remove` and `/add` round-trip on. */
  id: string;
  /** Everything this row can be matched by (wallet + username, or id + handle). */
  identifiers: string[];
}

/** A list response as rows, for the reconciler. */
export interface J7ListRowsResult {
  rows: J7TargetRow[];
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

/** Which fields identify a row, in preference order, per tracker. */
const ID_FIELDS = {
  pump_users: ['username', 'wallet'],
  fomo_users: ['handle', 'fomo_user_id'],
} as const;

/**
 * Narrow a list response keyed by `pump_users` / `fomo_users` into rows.
 *
 * j7 returns each tracked target as an OBJECT, not a string, and the identity
 * field differs by tracker: pump rows carry `username` (e.g. `"cupsey"`) plus
 * the caller's `wallet`, fomo rows carry `handle` (e.g. `"unipcs"`) plus
 * `fomo_user_id`. The FIRST present field is the row's `id` — the spelling that
 * round-trips with what `addPumpTarget`/`addFomoTarget` accept — and every
 * present field is kept for matching. A plain-string element is tolerated as a
 * fallback in case the shape ever flattens.
 */
function extractRows(raw: unknown, key: 'pump_users' | 'fomo_users'): J7ListRowsResult {
  if (typeof raw !== 'object' || raw === null) return { rows: [], limit: null };
  const r = raw as Record<string, unknown>;
  const arr = Array.isArray(r[key]) ? (r[key] as unknown[]) : [];

  const rows: J7TargetRow[] = [];
  for (const x of arr) {
    if (typeof x === 'string') {
      if (x !== '') rows.push({ id: x, identifiers: [x] });
      continue;
    }
    if (typeof x !== 'object' || x === null) continue;
    const row = x as Record<string, unknown>;
    const identifiers = ID_FIELDS[key]
      .map((f) => row[f])
      .filter((v): v is string => typeof v === 'string' && v !== '');
    if (identifiers.length === 0) continue;
    rows.push({ id: identifiers[0], identifiers });
  }

  const limit = typeof r.limit === 'number' && Number.isFinite(r.limit) ? r.limit : null;
  return { rows, limit };
}

/** The display-identifier view of a list response (`rows.map(r => r.id)`). */
function extractList(raw: unknown, key: 'pump_users' | 'fomo_users'): J7ListResult {
  const { rows, limit } = extractRows(raw, key);
  return { targets: rows.map((r) => r.id), limit };
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

/** As `listPumpTargets`, but every identifier per row — for the reconciler. */
export async function listPumpTargetRows(jwt: string): Promise<J7ListRowsResult> {
  return extractRows(await j7Fetch(jwt, '/pump/list', { method: 'GET' }), 'pump_users');
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

/** As `listFomoTargets`, but every identifier per row — for the reconciler. */
export async function listFomoTargetRows(jwt: string): Promise<J7ListRowsResult> {
  return extractRows(await j7Fetch(jwt, '/fomo/list', { method: 'GET' }), 'fomo_users');
}
