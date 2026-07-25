import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Machine auth for the /api/v1/bot surface (DISCORD_BOT_PLAN.md §2b).
// One shared service secret — the fomo-worker pattern — validated with a
// constant-time compare. Mounted ONLY on /api/v1/bot, before the user-auth
// /api router, so bot traffic never touches Supabase JWT verification.

function getConfiguredKey(): string | null {
  const key = process.env.OCT_BOT_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireBotAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = getConfiguredKey();
  if (!configured) {
    res.status(503).json({ error: 'Bot API is not configured on this server.' });
    return;
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token || !safeEqual(token, configured)) {
    res.status(401).json({ error: 'Invalid bot API key.' });
    return;
  }

  next();
}
