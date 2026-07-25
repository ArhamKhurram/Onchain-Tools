import { Router } from 'express';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

// Telegram auth flow (start/verify/2fa/disconnect/status) plus media + chats.
export function createTelegramRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { wsServer, storage, requireTelegramManager } = ctx;

  // Pending Telegram auth sessions (phone -> client, kept alive until verify completes)
  const pendingTelegramAuth = new Map<string, { client: TelegramClient; phoneCodeHash: string; phone: string }>();

  router.post('/auth/telegram/start', async (req, res) => {
    const userId = getUserId(req);
    const { apiId, apiHash, phoneNumber } = req.body;

    if (!apiId || !apiHash || !phoneNumber) {
      return res.status(400).json({ error: 'apiId, apiHash, and phoneNumber are required.' });
    }

    try {
      const numericApiId = parseInt(apiId, 10);
      if (isNaN(numericApiId)) {
        return res.status(400).json({ error: 'apiId must be a number.' });
      }

      const session = new StringSession('');
      const client = new TelegramClient(session, numericApiId, apiHash, {
        connectionRetries: 5,
      });

      await client.connect();

      const result = await client.sendCode(
        { apiId: numericApiId, apiHash },
        phoneNumber,
      );

      pendingTelegramAuth.set(userId, {
        client,
        phoneCodeHash: result.phoneCodeHash,
        phone: phoneNumber,
      });

      // Auto-cleanup after 5 minutes if not completed
      setTimeout(() => {
        const p = pendingTelegramAuth.get(userId);
        if (p && p.phone === phoneNumber) {
          p.client.disconnect().catch(() => {});
          pendingTelegramAuth.delete(userId);
        }
      }, 5 * 60 * 1000);

      await storage.updateConfig(userId, {
        telegramApiId: String(numericApiId),
        telegramApiHash: apiHash,
      });

      res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to start Telegram auth') });
    }
  });

  router.post('/auth/telegram/verify', async (req, res) => {
    const userId = getUserId(req);
    const { phoneCode, password } = req.body;

    const pending = pendingTelegramAuth.get(userId);
    if (!pending) {
      return res.status(400).json({ error: 'No pending Telegram auth. Call /auth/telegram/start first.' });
    }

    if (!phoneCode) {
      return res.status(400).json({ error: 'phoneCode is required.' });
    }

    try {
      const config = await storage.getConfig(userId);
      const numericApiId = parseInt(config.telegramApiId ?? '0', 10);
      const apiHash = config.telegramApiHash ?? '';

      try {
        await pending.client.invoke(
          new (await import('teleproto/tl/index.js')).Api.auth.SignIn({
            phoneNumber: pending.phone,
            phoneCodeHash: pending.phoneCodeHash,
            phoneCode,
          }),
        );
      } catch (err: any) {
        if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
          if (!password) {
            return res.json({ success: false, needs2FA: true });
          }
          await pending.client.signInWithPassword(
            { apiId: numericApiId, apiHash },
            { password: () => password, onError: (err) => { throw err; } },
          );
        } else {
          throw err;
        }
      }

      const sessionString = pending.client.session.save() as unknown as string;
      pendingTelegramAuth.delete(userId);

      const existingSessions = config.telegramSessions ?? [];
      const updatedSessions = [...existingSessions, sessionString];
      await storage.updateConfig(userId, { telegramSessions: updatedSessions });

      // Connect the telegram client
      const { connectTelegram } = await import('../../index.js');
      await connectTelegram(numericApiId, apiHash, updatedSessions, wsServer, userId);

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to verify Telegram code') });
    }
  });

  router.post('/auth/telegram/2fa', async (req, res) => {
    const userId = getUserId(req);
    const { password } = req.body;

    const pending = pendingTelegramAuth.get(userId);
    if (!pending) {
      return res.status(400).json({ error: 'No pending Telegram auth.' });
    }

    if (!password) {
      return res.status(400).json({ error: 'password is required.' });
    }

    try {
      const config = await storage.getConfig(userId);
      const numericApiId = parseInt(config.telegramApiId ?? '0', 10);
      const apiHash = config.telegramApiHash ?? '';

      await pending.client.signInWithPassword(
        { apiId: numericApiId, apiHash },
        { password: () => password, onError: (err) => { throw err; } },
      );

      const sessionString = pending.client.session.save() as unknown as string;
      pendingTelegramAuth.delete(userId);

      const existingSessions = config.telegramSessions ?? [];
      const updatedSessions = [...existingSessions, sessionString];
      await storage.updateConfig(userId, { telegramSessions: updatedSessions });

      const { connectTelegram } = await import('../../index.js');
      await connectTelegram(numericApiId, apiHash, updatedSessions, wsServer, userId);

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to verify 2FA password') });
    }
  });

  router.post('/auth/telegram/disconnect', async (req, res) => {
    const userId = getUserId(req);
    await storage.updateConfig(userId, { telegramSessions: [] });
    const { disconnectTelegram } = await import('../../index.js');
    disconnectTelegram(userId);
    res.json({ success: true });
  });

  router.get('/auth/telegram/status', async (req, res) => {
    const userId = getUserId(req);
    const config = await storage.getConfig(userId);
    const { getUserTelegram } = await import('../../index.js');
    const tg = getUserTelegram(userId);
    res.json({
      configured: (config.telegramSessions?.length ?? 0) > 0,
      connected: tg !== null && tg.isConnected(),
      hasApiCredentials: !!(config.telegramApiId && config.telegramApiHash),
      sessionCount: config.telegramSessions?.length ?? 0,
    });
  });

  // --- Telegram Media & Avatars ---

  const avatarCache = new Map<string, { buffer: Buffer; timestamp: number }>();
  const AVATAR_CACHE_TTL = 3600_000; // 1 hour

  router.get('/telegram/avatar/:peerId', async (req, res) => {
    const { peerId } = req.params;
    const cached = avatarCache.get(peerId);
    if (cached && Date.now() - cached.timestamp < AVATAR_CACHE_TTL) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(cached.buffer);
    }

    const tg = await requireTelegramManager(req, res);
    if (!tg) return;
    await tg.waitUntilReady();

    const buffer = await tg.downloadProfilePhoto(peerId);
    if (!buffer) {
      return res.status(404).json({ error: 'Profile photo not found' });
    }

    avatarCache.set(peerId, { buffer, timestamp: Date.now() });
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  });

  const mediaCache = new Map<string, { buffer: Buffer; mimeType: string; timestamp: number }>();
  const MEDIA_CACHE_TTL = 3600_000;

  router.get('/telegram/media/:chatId/:messageId', async (req, res) => {
    const { chatId, messageId } = req.params;
    const cacheKey = `${chatId}:${messageId}`;

    const cached = mediaCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < MEDIA_CACHE_TTL) {
      res.set('Content-Type', cached.mimeType);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buffer);
    }

    const tg = await requireTelegramManager(req, res);
    if (!tg) return;
    await tg.waitUntilReady();

    const result = await tg.downloadMediaByIds(chatId, parseInt(messageId, 10));
    if (!result) {
      return res.status(404).json({ error: 'Media not found' });
    }

    if (result.buffer.length < 10_000_000) {
      mediaCache.set(cacheKey, { ...result, timestamp: Date.now() });
    }
    res.set('Content-Type', result.mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(result.buffer);
  });

  // --- Telegram Chats ---

  router.get('/telegram/chats', async (req, res) => {
    const tg = await requireTelegramManager(req, res);
    if (!tg) return;
    await tg.waitUntilReady();
    const chats = await tg.getChats();
    res.json(chats);
  });

  return router;
}
