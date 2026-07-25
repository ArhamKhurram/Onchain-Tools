import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { isHostedMode } from '../../storage/index.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

// Discord token management + auth status/profile. Telegram auth lives in
// telegram.ts.
export function createAuthRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { wsServer, storage, ensureTelegramManager } = ctx;

  router.get('/auth/status', async (req, res) => {
    const userId = getUserId(req);
    const { getUserGateway } = await import('../../index.js');
    const config = await storage.getConfig(userId);
    const tg = await ensureTelegramManager(userId);

    if (isHostedMode()) {
      return res.json({
        configured: false,
        connected: false,
        clientGateway: true,
        telegramConfigured: (config.telegramSessions?.length ?? 0) > 0,
        telegramConnected: tg !== null && tg.isConnected(),
      });
    }

    const tokens = await storage.getTokens(userId);
    const gw = getUserGateway(userId);
    res.json({
      configured: tokens.length > 0,
      connected: gw !== null,
      telegramConfigured: (config.telegramSessions?.length ?? 0) > 0,
      telegramConnected: tg !== null && tg.isConnected(),
    });
  });

  router.get('/auth/profile', async (req, res) => {
    if (!isHostedMode()) {
      return res.json({ email: null, provider: 'local', createdAt: null });
    }

    const userId = getUserId(req);
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return res.status(500).json({ error: 'Server misconfigured' });

    try {
      const sb = createClient(url, key, { auth: { persistSession: false } });
      const { data, error } = await sb.auth.admin.getUserById(userId);
      if (error || !data.user) return res.status(404).json({ error: 'User not found' });

      const user = data.user;
      const provider = user.app_metadata?.provider ?? 'email';
      const discordMeta = user.user_metadata ?? {};

      res.json({
        id: user.id,
        email: user.email ?? null,
        provider,
        discordUsername: provider === 'discord' ? (discordMeta.full_name ?? discordMeta.name ?? null) : null,
        discordAvatar: provider === 'discord' ? (discordMeta.avatar_url ?? null) : null,
        createdAt: user.created_at,
        lastSignIn: user.last_sign_in_at ?? null,
      });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch profile') });
    }
  });

  router.post('/auth/token', async (req, res) => {
    if (isHostedMode()) {
      return res.json({
        success: true,
        clientGateway: true,
        message: 'Discord tokens are stored locally in your browser and never sent to the server.',
      });
    }

    const userId = getUserId(req);
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return res.status(400).json({ error: 'A valid Discord token is required.' });
    }

    const tokens = token.includes(',')
      ? token.split(',').map((t: string) => t.trim()).filter(Boolean)
      : [token.trim()];

    try {
      await storage.setTokens(userId, tokens);
      const { connectGateway } = await import('../../index.js');
      connectGateway(tokens, wsServer, userId);
      res.json({ success: true, tokenCount: tokens.length });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to save token or connect') });
    }
  });

  router.post('/auth/disconnect', async (req, res) => {
    const userId = getUserId(req);
    if (isHostedMode()) {
      await storage.setTokens(userId, []);
      const { disconnectGateway } = await import('../../index.js');
      disconnectGateway(userId);
      return res.json({ success: true, clientGateway: true });
    }
    await storage.setTokens(userId, []);
    const { disconnectGateway } = await import('../../index.js');
    disconnectGateway(userId);
    res.json({ success: true });
  });

  router.get('/auth/tokens', async (req, res) => {
    if (isHostedMode()) {
      return res.json({ tokens: [], count: 0, clientGateway: true });
    }

    const userId = getUserId(req);
    const tokens = await storage.getTokens(userId);
    const { getUserGateway } = await import('../../index.js');
    const invalidIndices = new Set(getUserGateway(userId)?.getInvalidTokenIndices() ?? []);
    const masked = tokens.map((t, index) => {
      const len = t.length;
      const visible = Math.min(4, Math.floor(len / 4));
      const maskedToken = len <= 8
        ? '*'.repeat(len)
        : t.slice(0, visible) + '*'.repeat(Math.max(4, len - visible * 2)) + t.slice(-visible);
      return { index, masked: maskedToken, invalid: invalidIndices.has(index) };
    });
    res.json({ tokens: masked, count: tokens.length });
  });

  router.post('/auth/tokens/add', async (req, res) => {
    if (isHostedMode()) {
      return res.json({
        success: true,
        clientGateway: true,
        message: 'Add Discord tokens in Settings — they stay in your browser only.',
      });
    }

    const userId = getUserId(req);
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return res.status(400).json({ error: 'A valid Discord token is required.' });
    }
    const existing = await storage.getTokens(userId);
    const trimmed = token.trim();
    if (existing.includes(trimmed)) {
      return res.status(409).json({ error: 'This token is already configured.' });
    }
    const updated = [...existing, trimmed];
    await storage.setTokens(userId, updated);

    try {
      const { connectGateway } = await import('../../index.js');
      connectGateway(updated, wsServer, userId);
      res.json({ success: true, tokenCount: updated.length });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to connect') });
    }
  });

  router.delete('/auth/tokens/:index', async (req, res) => {
    if (isHostedMode()) {
      return res.json({ success: true, clientGateway: true, tokenCount: 0 });
    }

    const userId = getUserId(req);
    const index = parseInt(req.params.index, 10);
    const existing = await storage.getTokens(userId);
    if (isNaN(index) || index < 0 || index >= existing.length) {
      return res.status(400).json({ error: 'Invalid token index.' });
    }
    const updated = existing.filter((_, i) => i !== index);
    await storage.setTokens(userId, updated);

    try {
      if (updated.length > 0) {
        const { connectGateway } = await import('../../index.js');
        connectGateway(updated, wsServer, userId);
      } else {
        const { disconnectGateway } = await import('../../index.js');
        disconnectGateway(userId);
      }
      res.json({ success: true, tokenCount: updated.length });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to reconnect') });
    }
  });

  return router;
}
