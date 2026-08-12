import { Router } from 'express';
import type { WsServer } from '../ws/server.js';
import { createFomoRouter } from '../fomo/routes.js';
import { createPumpfunRouter } from '../pumpfun/routes.js';
import { createPortfolioRouter } from '../portfolio/routes.js';
import { createRouterContext } from './context.js';
import { createAuthRoutes } from './routes/auth.js';
import { createTelegramRoutes } from './routes/telegram.js';
import { createDiscordRoutes } from './routes/discord.js';
import { createRoomsRoutes } from './routes/rooms.js';
import { createConfigRoutes } from './routes/config.js';
import { createSoundsRoutes } from './routes/sounds.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { createContractsRoutes } from './routes/contracts.js';
import { createNetworkScansRoutes } from './routes/networkScans.js';
import { createAlertsRoutes } from './routes/alerts.js';
import { createRevivalRoutes } from './routes/revival.js';
import { createJournalRoutes } from './routes/journal.js';
import { createCallersRoutes } from './routes/callers.js';
import { createAdminRoutes } from './routes/admin.js';
import { createPushoverRoutes } from './routes/pushover.js';

// Thin composition root for the /api surface. Each domain lives in its own
// sub-router under ./routes/; the shared gateway/telegram/storage context is
// built once and threaded through. Mount order preserves the original route
// registration order.
export function createRouter(wsServer: WsServer): Router {
  const router = Router();
  const ctx = createRouterContext(wsServer);

  router.use(createAuthRoutes(ctx));       // /auth/status, /auth/profile, /auth/token(s)
  router.use(createTelegramRoutes(ctx));   // /auth/telegram/*, /telegram/*
  router.use(createDiscordRoutes(ctx));    // /history, /guilds, /dm-channels, /reactions
  router.use(createRoomsRoutes(ctx));      // /rooms
  router.use(createConfigRoutes(ctx));     // /config, /config/export, /config/import
  router.use(createSoundsRoutes(ctx));     // /sounds, /channel-sounds
  router.use(createMessagingRoutes(ctx));  // /send-message
  router.use(createContractsRoutes(ctx));  // /tokens/*/snapshot, /contracts*
  router.use(createNetworkScansRoutes(ctx)); // /network-scans/lookup
  router.use(createAlertsRoutes(ctx));     // /alerts/missed-runner/test
  router.use(createRevivalRoutes(ctx));    // /revival/alerts
  router.use(createJournalRoutes(ctx));    // /journal/*
  router.use(createCallersRoutes(ctx));    // /callers/scores
  router.use(createAdminRoutes(wsServer)); // /admin/stats (operator only)
  router.use(createPushoverRoutes(ctx));   // /pushover/signal-convergence

  router.use('/fomo', createFomoRouter(wsServer));
  router.use('/pumpfun', createPumpfunRouter());
  router.use('/portfolio', createPortfolioRouter());

  return router;
}
