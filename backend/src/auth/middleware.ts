import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { isHostedMode } from '../storage/index.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const LOCAL_USER_ID = 'local';

// Token verification cache. `supabase.auth.getUser(token)` is a GoTrue network round-trip — and
// therefore Supabase EGRESS — on every hosted request. The console polls hard (sniper 20s, radar
// 60s, price/journal/revival, portfolio…), so a single active user fires dozens of identical
// verifications a minute, each re-hitting GoTrue for a JWT that has not changed. Caching the
// (token → userId) result for a short TTL collapses that to one round-trip per token per window.
//
// Tradeoff, stated plainly: a token revoked server-side stays accepted for up to TTL_MS. Supabase
// access tokens are short-lived (~1h) and this window is 60s, so the exposure is a minute at most —
// the standard trade every auth cache makes. Invalid tokens are NOT cached (only positive results),
// so a bad token still gets rejected every time. Bounded to cap memory; oldest-inserted evicted.
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX = 5_000;
const authCache = new Map<string, { userId: string; at: number }>();

function cachedUserId(token: string): string | null {
  const hit = authCache.get(token);
  if (hit && Date.now() - hit.at < AUTH_CACHE_TTL_MS) return hit.userId;
  if (hit) authCache.delete(token); // expired
  return null;
}

function rememberUserId(token: string, userId: string): void {
  if (authCache.size >= AUTH_CACHE_MAX) {
    // Map preserves insertion order; drop the oldest entry to bound memory.
    const oldest = authCache.keys().next().value;
    if (oldest !== undefined) authCache.delete(oldest);
  }
  authCache.set(token, { userId, at: Date.now() });
}

let _verifier: ReturnType<typeof createClient> | null = null;

function getVerifier() {
  if (_verifier) return _verifier;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required in hosted mode.');
  }
  _verifier = createClient(url, key, { auth: { persistSession: false } });
  return _verifier;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // NOTE: there is deliberately no per-path bypass here. `/portfolio/status`
  // used to skip auth, but its `probeChain`/`probeAddress` query params drive
  // live Birdeye calls against an arbitrary address, so an unauthenticated
  // bypass let anyone spend the operator's paid quota. In local mode the
  // endpoint stays reachable via the `userId = 'local'` branch below; hosted
  // mode now requires a bearer token like every other `/api` route.
  if (!isHostedMode()) {
    req.userId = LOCAL_USER_ID;
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const token = header.slice(7);

  const cached = cachedUserId(token);
  if (cached) {
    req.userId = cached;
    next();
    return;
  }

  const supabase = getVerifier();
  supabase.auth.getUser(token).then(({ data, error }) => {
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired session.' });
      return;
    }
    rememberUserId(token, data.user.id);
    req.userId = data.user.id;
    next();
  }).catch(() => {
    res.status(401).json({ error: 'Authentication failed.' });
  });
}
