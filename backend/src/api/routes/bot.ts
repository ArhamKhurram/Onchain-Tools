import { Router } from 'express';
import { isHostedMode } from '../../storage/index.js';
import {
  BotServiceError,
  DEFAULT_NETWORK_ID,
  getBotHolders,
  getBotLeaderboard,
  getBotSnapshot,
  getBotTracked,
  resolveNetworkId,
} from '../../bot/service.js';
import { AnnounceError, postAnnouncement, type AnnounceKind } from '../../bot/announce.js';
import { getBotClient } from '../../bot/index.js';

// Versioned bot API (DISCORD_BOT_PLAN.md §3) — mounted at /api/v1/bot behind
// requireBotAuth, BEFORE the user-auth /api router. Thin adapters over
// bot/service.ts; responses are the @oct/shared bot DTOs.

function statusFor(err: BotServiceError): number {
  switch (err.code) {
    case 'not_configured': return 503;
    case 'not_found': return 404;
    case 'not_linked': return 403;
    case 'upstream': return 502;
  }
}

function handleError(res: any, err: unknown, fallback: string): void {
  if (err instanceof BotServiceError) {
    res.status(statusFor(err)).json({ error: err.message });
    return;
  }
  if (!isHostedMode()) {
    res.status(500).json({ error: (err as Error)?.message ?? fallback });
    return;
  }
  console.error(`[BotAPI] ${fallback}:`, (err as Error)?.message ?? err);
  res.status(500).json({ error: fallback });
}

export function createBotRouter(): Router {
  const router = Router();

  // GET /api/v1/bot/tokens/:network/:address/holders
  // :network accepts a FOMO network id ("1399811149") or an OCT chain slug
  // ("sol", "eth", "bsc", "base", "robinhood"). Unknown → 400.
  router.get('/tokens/:network/:address/holders', async (req, res) => {
    const { network, address } = req.params;
    const networkId = resolveNetworkId(network);
    if (!networkId) {
      return res.status(400).json({ error: `Unsupported network "${network}".` });
    }
    if (!address || address.length < 8) {
      return res.status(400).json({ error: 'A token address is required.' });
    }
    try {
      res.json(await getBotHolders(address, networkId));
    } catch (err) {
      handleError(res, err, 'Failed to fetch holders');
    }
  });

  // GET /api/v1/bot/fomo/leaderboard?window=24h|all&limit=25
  router.get('/fomo/leaderboard', async (req, res) => {
    const window = req.query.window === '24h' ? '24h' as const : 'all' as const;
    const limitRaw = Number.parseInt(String(req.query.limit ?? '25'), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
    try {
      res.json(await getBotLeaderboard(window, limit));
    } catch (err) {
      handleError(res, err, 'Failed to fetch leaderboard');
    }
  });

  // GET /api/v1/bot/fomo/tracked — user-scoped. The caller identifies the
  // Discord user; OCT resolves it to an account via the stored OAuth identity.
  router.get('/fomo/tracked', async (req, res) => {
    const discordUserId = String(req.header('X-Discord-User-Id') ?? '').trim();
    if (!discordUserId) {
      return res.status(400).json({ error: 'X-Discord-User-Id header is required.' });
    }
    try {
      res.json(await getBotTracked(discordUserId));
    } catch (err) {
      handleError(res, err, 'Failed to fetch tracked traders');
    }
  });

  // GET /api/v1/bot/tokens/:chain/:address/snapshot — chain is an OCT slug.
  router.get('/tokens/:chain/:address/snapshot', async (req, res) => {
    const { chain, address } = req.params;
    if (!address || address.length < 8) {
      return res.status(400).json({ error: 'A token address is required.' });
    }
    try {
      res.json(await getBotSnapshot(chain, address));
    } catch (err) {
      handleError(res, err, 'Failed to fetch token snapshot');
    }
  });

  // POST /api/v1/bot/announce — internal-only. Posts a site/bot update
  // announcement to DISCORD_ANNOUNCE_CHANNEL_ID. No Discord command exists for
  // this: the intended caller is an LLM coding agent that writes the copy
  // itself right after shipping a change and calls this directly (authenticated
  // by the same OCT_BOT_API_KEY as the rest of this router — no new secret).
  router.post('/announce', async (req, res) => {
    const { title, description, kind, imageUrl, linkUrl } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required.' });
    }
    if (typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'description is required.' });
    }
    if (kind !== undefined && kind !== 'site' && kind !== 'bot') {
      return res.status(400).json({ error: 'kind must be "site" or "bot".' });
    }

    try {
      const result = await postAnnouncement(getBotClient(), {
        title: title.trim(),
        description: description.trim(),
        kind: (kind as AnnounceKind | undefined) ?? 'site',
        imageUrl: typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : null,
        linkUrl: typeof linkUrl === 'string' && linkUrl.trim() ? linkUrl.trim() : null,
      });
      res.json({ posted: true, channelId: result.channelId });
    } catch (err) {
      if (err instanceof AnnounceError) {
        const status =
          err.code === 'bot_disabled' || err.code === 'not_configured' ? 503 :
          err.code === 'forbidden' ? 403 :
          502;
        return res.status(status).json({ error: err.message });
      }
      handleError(res, err, 'Failed to post announcement');
    }
  });

  // Health/identity probe for bot consumers (auth check + version discovery).
  router.get('/status', (_req, res) => {
    res.json({
      ok: true,
      version: 1,
      defaultNetworkId: DEFAULT_NETWORK_ID,
      endpoints: [
        'GET /tokens/:network/:address/holders',
        'GET /fomo/leaderboard?window=24h|all&limit=25',
        'GET /tokens/:chain/:address/snapshot',
        'GET /fomo/tracked  (requires X-Discord-User-Id)',
        'POST /announce  { title, description, kind?, imageUrl?, linkUrl? }',
      ],
    });
  });

  return router;
}
