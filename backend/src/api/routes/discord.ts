import { Router } from 'express';
import { processDiscordMessage } from '../../utils/messageProcessor.js';
import { processTelegramMessage } from '../../telegram/messageProcessor.js';
import type { FrontendMessage } from '../../discord/types.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

// Channel history (Discord + Telegram) plus Discord guild/DM/reaction metadata.
export function createDiscordRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { wsServer, storage, requireGateway } = ctx;

  // --- Channel History ---

  router.get('/history', async (req, res) => {
    const userId = getUserId(req);
    const rooms = await storage.getRooms(userId);
    const result: Record<string, FrontendMessage[]> = {};

    // Separate Discord and Telegram channels
    const discordChannelToRooms = new Map<string, string[]>();
    const telegramChannelToRooms = new Map<string, string[]>();

    for (const room of rooms) {
      for (const ch of room.channels) {
        const isTelegram = ch.source === 'telegram';
        const map = isTelegram ? telegramChannelToRooms : discordChannelToRooms;
        const existing = map.get(ch.channelId) ?? [];
        existing.push(room.id);
        map.set(ch.channelId, existing);
      }
    }

    // Fetch Discord history
    if (discordChannelToRooms.size > 0) {
      const { getUserGateway, connectGateway } = await import('../../index.js');
      let gateway = getUserGateway(userId);
      if (!gateway) {
        const tokens = await storage.getTokens(userId);
        if (tokens.length > 0) {
          gateway = connectGateway(tokens, wsServer, userId);
        }
      }

      if (gateway) {
        await gateway.waitUntilReady();
        const BATCH_SIZE = 5;
        const channelIds = Array.from(discordChannelToRooms.keys());

        for (let i = 0; i < channelIds.length; i += BATCH_SIZE) {
          const batch = channelIds.slice(i, i + BATCH_SIZE);
          const fetches = batch.map(async (channelId) => {
            const rawMessages = await gateway!.fetchChannelMessages(channelId, 30);
            const roomIds = discordChannelToRooms.get(channelId) ?? [];
            for (const rawMsg of rawMessages) {
              const frontendMsg = processDiscordMessage(gateway!, rawMsg);
              for (const roomId of roomIds) {
                if (!result[roomId]) result[roomId] = [];
                result[roomId].push(frontendMsg);
              }
            }
          });
          await Promise.all(fetches);
        }
      }
    }

    // Fetch Telegram history
    if (telegramChannelToRooms.size > 0) {
      const { getUserTelegram } = await import('../../index.js');
      const tg = getUserTelegram(userId);

      if (tg) {
        await tg.waitUntilReady();
        const BATCH_SIZE = 3;
        const chatIds = Array.from(telegramChannelToRooms.keys());

        for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
          const batch = chatIds.slice(i, i + BATCH_SIZE);
          const fetches = batch.map(async (chatId) => {
            const rawMessages = await tg.fetchMessages(chatId, 30);
            const roomIds = telegramChannelToRooms.get(chatId) ?? [];
            for (const rawMsg of rawMessages) {
              const frontendMsg = processTelegramMessage(rawMsg);
              for (const roomId of roomIds) {
                if (!result[roomId]) result[roomId] = [];
                result[roomId].push(frontendMsg);
              }
            }
          });
          await Promise.all(fetches);
        }
      }
    }

    for (const roomId of Object.keys(result)) {
      result[roomId].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const seen = new Set<string>();
      result[roomId] = result[roomId].filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
    }

    res.json(result);
  });

  // --- Guilds & Channels ---

  router.get('/guilds', async (req, res) => {
    const gateway = await requireGateway(req, res);
    if (!gateway) return;
    await gateway.waitUntilReady();
    const guilds = await gateway.getGuilds();
    res.json(guilds);
  });

  router.get('/dm-channels', async (req, res) => {
    const gateway = await requireGateway(req, res);
    if (!gateway) return;
    await gateway.waitUntilReady();
    const dms = gateway.getDMChannels();
    res.json(dms);
  });

  // Users who reacted to a Discord message with a specific emoji.
  // `name` is the emoji name (unicode char for standard emoji); `id` is the
  // custom emoji id (omitted for standard emoji).
  router.get('/reactions/:channelId/:messageId', async (req, res) => {
    const { channelId, messageId } = req.params;
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!name) return res.status(400).json({ error: 'emoji name is required' });

    const gateway = await requireGateway(req, res);
    if (!gateway) return;
    await gateway.waitUntilReady();

    const emoji = id ? `${name}:${id}` : name;
    try {
      const users = await gateway.fetchReactionUsers(channelId, messageId, emoji);
      res.json(
        users.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.global_name || u.username,
          avatar: u.avatar,
          discriminator: u.discriminator,
        })),
      );
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch reaction users') });
    }
  });

  return router;
}
