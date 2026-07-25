import { Router } from 'express';
import type { RouterContext } from '../context.js';
import { getUserId, safeError, messageUpload } from '../shared.js';

// Outbound message sending (Discord + Telegram).
export function createMessagingRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { storage, requireGateway, requireTelegramManager } = ctx;

  router.post('/send-message', messageUpload.array('files', 10), async (req, res) => {
    const userId = getUserId(req);

    const config = await storage.getConfig(userId);
    if (!config.chattingEnabled) {
      return res.status(403).json({ error: 'Chatting is disabled. Enable it in Settings > General.' });
    }

    const { channelId, content, source } = req.body;
    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }
    if ((!content || !content.trim()) && (!req.files || (req.files as Express.Multer.File[]).length === 0)) {
      return res.status(400).json({ error: 'Message content or files required' });
    }

    try {
      const files = (req.files as Express.Multer.File[]) ?? [];
      const attachments = files.map((f) => ({
        filename: f.originalname,
        data: f.buffer,
        contentType: f.mimetype,
      }));

      if (source === 'telegram') {
        const tg = await requireTelegramManager(req, res);
        if (!tg) return;
        await tg.waitUntilReady();
        const result = await tg.sendMessage(channelId, content?.trim() ?? '', attachments.length > 0 ? attachments : undefined);
        res.json({ success: true, messageId: result.id });
      } else {
        const gateway = await requireGateway(req, res);
        if (!gateway) return;
        const result = await gateway.sendChannelMessage(channelId, content?.trim() ?? '', attachments.length > 0 ? attachments : undefined);
        res.json({ success: true, messageId: result.id });
      }
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to send message') });
    }
  });

  return router;
}
