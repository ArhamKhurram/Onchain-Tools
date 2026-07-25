import { getStorageProvider } from '../storage/index.js';
import type { StorageProvider } from '../storage/interface.js';
import type { WsServer } from '../ws/server.js';
import type { GatewayManager } from '../discord/gatewayManager.js';
import type { TelegramClientManager } from '../telegram/clientManager.js';
import { getUserId } from './shared.js';

// Shared per-router context. Holds the singletons and the connect-on-demand
// helpers that several route groups depend on (Discord gateway, Telegram
// manager). Built once by createRouter and threaded into each sub-router.
export interface RouterContext {
  wsServer: WsServer;
  storage: StorageProvider;
  requireGateway(req: any, res: any): Promise<GatewayManager | null>;
  ensureTelegramManager(userId: string): Promise<TelegramClientManager | null>;
  requireTelegramManager(req: any, res: any): Promise<TelegramClientManager | null>;
}

export function createRouterContext(wsServer: WsServer): RouterContext {
  const storage = getStorageProvider();

  async function requireGateway(req: any, res: any): Promise<GatewayManager | null> {
    const { getUserGateway, connectGateway } = await import('../index.js');
    const userId = getUserId(req);
    let gw = getUserGateway(userId);

    if (!gw) {
      const tokens = await storage.getTokens(userId);
      if (tokens.length > 0) {
        gw = connectGateway(tokens, wsServer, userId);
      }
    }

    if (!gw) {
      res.status(503).json({ error: 'Discord not connected. Please configure your token first.' });
      return null;
    }
    return gw;
  }

  async function ensureTelegramManager(userId: string): Promise<TelegramClientManager | null> {
    const { getUserTelegram, connectTelegram, disconnectTelegram } = await import('../index.js');
    let tg = getUserTelegram(userId);

    if (tg && !tg.isConnected()) {
      disconnectTelegram(userId);
      tg = null;
    }

    if (!tg) {
      const config = await storage.getConfig(userId);
      if (config.telegramSessions?.length && config.telegramApiId && config.telegramApiHash) {
        try {
          tg = await connectTelegram(
            parseInt(config.telegramApiId),
            config.telegramApiHash,
            config.telegramSessions,
            wsServer,
            userId,
          );
        } catch (err) {
          console.error('[API] Telegram reconnect failed:', (err as Error).message);
        }
      }
    }

    return tg;
  }

  async function requireTelegramManager(req: any, res: any): Promise<TelegramClientManager | null> {
    const tg = await ensureTelegramManager(getUserId(req));
    if (!tg) {
      res.status(503).json({ error: 'Telegram not connected. Please configure Telegram first.' });
      return null;
    }
    return tg;
  }

  return { wsServer, storage, requireGateway, ensureTelegramManager, requireTelegramManager };
}
