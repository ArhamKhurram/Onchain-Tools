// Auth and origin gating for /sniper/v1.
//
// This is the one place in the codebase where copying the house
// `createXRoutes(ctx)` pattern is WRONG, and the docs say so in three places
// (sniper-execution.md:274-295, ADR-011:72-78, sniper-security.md T12). The
// sniper router mounts OUTSIDE /api and BEFORE the app-wide cors(), so it
// inherits nothing: not the CORS policy, not the body parser, not the rate
// limiter, and not authMiddleware. Every one of those has to be re-applied here,
// by hand.
//
// The point of not inheriting cors() is NOT that this surface emits no CORS
// header at all — the console is cross-origin in both shipped deployments
// (hosted: Vercel console -> Railway backend, which VITE_API_URL mandates; local
// dev: the vite server on :5173 -> the backend on :3001), so a plane that
// answered every preflight with 403 would render the Sniper tab permanently
// empty. The point is that the ALLOW LIST is this file's, not index.ts's: local
// `app.use(cors())` is a wildcard, and hosted cors() goes permissive when
// ALLOWED_ORIGINS is unset. Neither may reach a surface that spends money. So
// `denyCrossOrigin` is a full CORS implementation for the origins it allows and
// a hard 403-with-no-headers for everything else — and in local mode "allowed"
// means the console's own origin, not merely a loopback one, because the origin
// gate is what stands between a stray localhost page and GET /session's token.

import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isHostedMode } from '../../storage/index.js';
import { getSniperControlToken } from './controlToken.js';

const LOCAL_USER_ID = 'local';

/** Loopback hostnames a local console can legitimately be served from. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function urlOf(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The explicit allow list, shared with index.ts's hosted CORS layer. */
function configuredOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Where a dev console is served from. Two fixed ports, not a range — both are
 * pinned with `strictPort: true`, so a dev console is on one of them or has
 * failed to start:
 *
 * - 5173, frontend/vite.config.ts, the console's own dev server.
 * - 5174, landing/vite.config.ts, which proxies /dashboard to 5173 and is the
 *   entry point `npm run dev` and the README actually tell you to open. Omitting
 *   it left the documented dev flow with a permanently empty Sniper tab whenever
 *   VITE_API_URL is set, since the page origin is then 5174 while the request
 *   goes cross-origin straight to the backend on 3001.
 *
 * Both vite configs also proxy /sniper/v1 without `changeOrigin`, so with
 * VITE_API_URL unset the request is same-origin and never reaches this set.
 */
const LOCAL_DEV_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
]);

/**
 * Is this Origin one we accept, per mode?
 *
 * `selfHost` is the request's own `Host` header, i.e. the origin the console
 * addressed this server AS. It is what makes the same-origin case expressible:
 * a browser will not let a page forge `Host` (it is a forbidden header) and does
 * not let it forge `Origin`, so `origin.host === selfHost` is a real
 * same-origin proof and not a self-assertion.
 */
export function isAllowedOrigin(origin: string, selfHost?: string): boolean {
  const url = urlOf(origin);
  if (!url) return false;

  if (isHostedMode()) {
    // Fails CLOSED. An unset ALLOWED_ORIGINS makes the hosted /api CORS layer
    // permissive (index.ts) but must never do so here: the console always knows
    // its own origin, and an operator who forgot the env var should get a broken
    // sniper tab rather than a cross-origin-writable one.
    return configuredOrigins().includes(origin);
  }

  // LOCAL. Loopback is necessary and NOT sufficient, and the difference is the
  // whole of threat T12 for this surface: `GET /sniper/v1/session` hands out the
  // per-boot control token, so any origin allowed here can read that token and
  // then spend. A page the operator opens from some other dev server on
  // localhost:8080 is loopback too. So the set is the console's origin, not
  // every port on the machine.
  if (!LOCAL_HOSTS.has(url.hostname)) return false;

  // An explicit list wins, for a console served from somewhere unusual. Same env
  // var as hosted, so there is one thing to set and one thing to audit.
  const configured = configuredOrigins();
  if (configured.length > 0) return configured.includes(origin);

  // Same-origin: the desktop shell, where this server serves the console itself
  // (index.ts express.static), and dev through vite's own /sniper/v1 proxy.
  if (selfHost && url.host === selfHost) return true;

  // Cross-origin dev: vite on :5173 against the backend on :3001, which is what
  // happens the moment VITE_API_URL is set. Excluded from a packaged desktop
  // build — it sets NODE_ENV=production (desktop/main.js) and serves its own
  // console, so it has no dev server to trust and no reason to trust one.
  return process.env.NODE_ENV !== 'production' && LOCAL_DEV_ORIGINS.has(origin);
}

/**
 * The exact request headers sniperApi.ts sends. Listed rather than echoed from
 * `Access-Control-Request-Headers`, because echoing turns the allow list into
 * whatever the caller asked for.
 */
const ALLOWED_REQUEST_HEADERS = 'Authorization, Content-Type, X-OCT-Sniper-Token';

/** Every method the router actually exposes. No PUT, no HEAD. */
const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

/**
 * Gate the control plane on Origin, and speak CORS to the origins that pass.
 *
 * Allowed origin  -> Access-Control-Allow-Origin echoing that EXACT origin
 *                    (never '*', which would also be illegal alongside a
 *                    credentialed request), plus Vary: Origin so a shared cache
 *                    cannot serve one origin's allow header to another. A
 *                    preflight gets 204 with the method/header lists.
 * Anything else   -> 403 and NOT ONE Access-Control-* header. A preflight that
 *                    gets no allow header back is a preflight the browser
 *                    refuses to follow, so the block does not depend on the
 *                    subsequent request also being refused correctly.
 *
 * Access-Control-Allow-Credentials is deliberately NEVER sent: this plane
 * authenticates on a header it sets itself (Authorization / X-OCT-Sniper-Token)
 * and on nothing ambient. Withholding it means a browser will refuse to attach
 * cookies here even from an allowed origin, so a cookie added to this app in
 * future cannot silently become a CSRF vector against the one surface that
 * spends. sniperApi.ts sends no credentials, so nothing today needs it.
 */
export function denyCrossOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';

  // Set on every answer, allowed or refused, so an intermediary cache keyed on
  // the URL alone cannot reuse one origin's response for another's request.
  res.vary('Origin');

  const allowed = origin.length > 0 && isAllowedOrigin(origin, req.headers.host);

  if (origin.length > 0 && !allowed) {
    res.status(403).json({ error: 'Cross-origin requests are not permitted on the sniper control plane.' });
    return;
  }

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  if (req.method === 'OPTIONS') {
    // A real preflight always carries Origin, so an OPTIONS without one is a
    // probe rather than a browser, and gets the same nothing a bad origin does.
    if (!allowed) {
      res.status(403).end();
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
    // Ten minutes. Long enough to keep the Sniper tab from preflighting on every
    // poll, short enough that tightening ALLOWED_ORIGINS takes effect promptly.
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
    return;
  }

  // In local mode the server binds loopback, but a DNS-rebinding attack reaches
  // it with an attacker-controlled Host header. Pinning Host to a loopback name
  // closes that without affecting a console served from localhost.
  if (!isHostedMode()) {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host && !LOCAL_HOSTS.has(host)) {
      res.status(403).json({ error: 'The sniper control plane is loopback-only in local mode.' });
      return;
    }
  }

  next();
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  // Compare lengths first and still run the constant-time compare on equal-length
  // input, so the only thing an attacker learns from timing is the length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

let _verifier: SupabaseClient | null = null;

function getVerifier(): SupabaseClient {
  if (_verifier) return _verifier;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required in hosted mode.');
  }
  _verifier = createClient(url, key, { auth: { persistSession: false } });
  return _verifier;
}

/**
 * Authenticate the sniper control plane. Hosted: the Supabase bearer, verified
 * with the same `auth.getUser(token)` call auth/middleware.ts:51-57 makes —
 * re-applied by hand because mounting outside /api means not inheriting it.
 * Local: the per-boot control token, compared in constant time.
 */
export function requireSniperAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isHostedMode()) {
    const presented = req.headers['x-oct-sniper-token'];
    const token = typeof presented === 'string' ? presented : '';
    if (!token || !constantTimeEquals(token, getSniperControlToken())) {
      res.status(401).json({ error: 'Sniper control token required.' });
      return;
    }
    req.userId = LOCAL_USER_ID;
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  getVerifier()
    .auth.getUser(header.slice(7))
    .then(({ data, error }) => {
      if (error || !data.user) {
        res.status(401).json({ error: 'Invalid or expired session.' });
        return;
      }
      req.userId = data.user.id;
      next();
    })
    .catch(() => {
      res.status(401).json({ error: 'Authentication failed.' });
    });
}

/** True when the socket's peer is loopback. Gates GET /sniper/v1/session. */
export function isLoopbackRequest(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
