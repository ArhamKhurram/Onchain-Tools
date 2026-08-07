// The local-mode control-plane credential.
//
// Local mode has no auth at all — auth/middleware.ts:36-39 sets
// req.userId = 'local' with no credential, and index.ts falls through to a
// wildcard `app.use(cors())`. For every other route that is a deliberate
// tradeoff (ADR-008: loopback, single tenant). For a route that SPENDS MONEY it
// is not: without a credential, any web page the operator visits could
// `fetch('http://127.0.0.1:3001/sniper/v1/rules', …)` and author an armed rule
// with caps of its own choosing, and every control in executeFire would be
// intact and irrelevant (docs/architecture/sniper-security.md, threat T12).
//
// So local mode gets a per-boot bearer: 32 random bytes, held in memory and
// mirrored to a 0600 file under OCT_DATA_DIR so the desktop shell can read it
// without an HTTP round trip. NEVER logged.

import { randomBytes } from 'crypto';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../../data');
const TOKEN_PATH = join(DATA_DIR, 'sniper-control-token');

let _token: string | null = null;

/**
 * The per-boot control token. Rotating on every boot is the point: a token that
 * outlived the process would have to be revocable, and there is nothing here to
 * revoke it with.
 *
 * `SNIPER_CONTROL_TOKEN` overrides it for the desktop shell (which wants to
 * choose the value it will hand the renderer) and for CI.
 */
export function getSniperControlToken(): string {
  if (_token) return _token;

  const injected = process.env.SNIPER_CONTROL_TOKEN?.trim();
  if (injected) {
    _token = injected;
    return _token;
  }

  _token = randomBytes(32).toString('hex');
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    // 0600 is the control against a hostile LOCAL process, which is the one
    // threat the Origin check cannot touch — a local process can forge any
    // header it likes. The file mode and the desktop app reading it directly
    // (rather than calling GET /session) are what bound that case.
    writeFileSync(TOKEN_PATH, _token, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Non-fatal: the token still works over GET /sniper/v1/session. Only the
    // desktop delivery path is lost, and it is not wired up yet anyway.
    console.error('[Sniper] Failed to write the control token file:', (err as Error).message);
  }
  return _token;
}

/** Test seam — forces the next getSniperControlToken() to mint a new value. */
export function resetSniperControlToken(): void {
  _token = null;
}
