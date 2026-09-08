import { Router } from 'express';
import { getUserId, safeError } from '../shared.js';
import {
  getLinkCodeService,
  LINK_CODE_TTL_MS,
  MINT_MAX_IN_WINDOW,
  MINT_WINDOW_MS,
} from '../../tgbot/linkCodes.js';
import { accountFingerprint } from '../../tgbot/identity.js';

/**
 * Minting a Telegram link code.
 *
 * THIS ENDPOINT IS THE "PROOF OF THE ACCOUNT" HALF of the linking flow. Its
 * whole security argument is one line of code — `getUserId(req)` — and the fact
 * that nothing else in it accepts an account from the caller. The code is minted
 * FOR THE AUTHENTICATED USER and for nobody else: there is no `userId` in the
 * body, no `?as=`, no admin override. So the only way to obtain a code that
 * binds a chat to account U is to be signed in as U, and the only way to redeem
 * it is to be an admin of the chat you send it in (tgbot/commands/link.ts).
 *
 * ON `/api`, LIKE THE FILTERS ROUTE AND UNLIKE THE SNIPER. In hosted mode
 * `/api` is Supabase-bearer authenticated, which is exactly the proof this
 * needs. In LOCAL mode `/api` has no auth and every request is `local` — and
 * that is correct here rather than dangerous, because local mode has exactly
 * one user, the server binds loopback, and the code that comes back binds a
 * chat to that same single account. There is nobody else to impersonate.
 *
 * THE RESPONSE IS THE ONLY PLACE THE CODE EVER EXISTS IN PLAINTEXT. It is not
 * stored (only its SHA-256 is), not logged, and there is deliberately no GET:
 * a "show me my current code" endpoint would turn a ten-minute credential into
 * a permanent one for anyone who ever gets a session.
 */
export function createTgBotRoutes(): Router {
  const router = Router();

  router.post('/tgbot/link-code', async (req, res) => {
    try {
      const userId = getUserId(req);
      const result = await getLinkCodeService().mint(userId);

      if (!result.ok) {
        if (result.reason === 'rate_limited') {
          return res.status(429).json({
            error: `Too many link codes. You can generate ${MINT_MAX_IN_WINDOW} every ${Math.round(
              MINT_WINDOW_MS / 60_000,
            )} minutes.`,
          });
        }
        return res
          .status(503)
          .json({ error: 'Could not generate a link code right now. Try again in a minute.' });
      }

      res.json({
        code: result.code,
        expiresAt: result.expiresAt,
        ttlMs: LINK_CODE_TTL_MS,
        // The same fingerprint the bot prints once the chat is bound, so the
        // two can be compared by eye. Not an identifier anyone can act on —
        // see identity.ts for why it is a fingerprint and not an email.
        account: accountFingerprint(userId),
      });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to generate a link code') });
    }
  });

  return router;
}
