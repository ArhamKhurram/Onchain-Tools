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
  const supabase = getVerifier();

  supabase.auth.getUser(token).then(({ data, error }) => {
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired session.' });
      return;
    }
    req.userId = data.user.id;
    next();
  }).catch(() => {
    res.status(401).json({ error: 'Authentication failed.' });
  });
}
