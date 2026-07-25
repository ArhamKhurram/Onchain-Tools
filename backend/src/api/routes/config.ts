import { Router } from 'express';
import { isHostedMode } from '../../storage/index.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

// Global config get/put plus settings export/import.
export function createConfigRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { wsServer, storage } = ctx;

  router.get('/config', async (req, res) => {
    const userId = getUserId(req);
    const fullConfig = await storage.getConfig(userId);
    const { discordTokens, telegramSessions, ...safeConfig } = fullConfig;
    res.json(safeConfig);
  });

  router.put('/config', async (req, res) => {
    const userId = getUserId(req);
    const { globalHighlightedUsers, contractDetection, guildColors, dmColors, telegramColors, enabledGuilds, hiddenUsers, evmAddressColor, solAddressColor, openInDiscordApp, openInTelegramApp, messageSounds, soundSettings, channelSounds, pushover, missedRunner, contractLinkTemplates, contractClickAction, showFullContractAddress, autoOpenHighlightedContracts, signalConvergenceWindowMinutes, globalKeywordPatterns, keywordAlertsEnabled, desktopNotifications, toastAlertsEnabled, toastPosition, mentionsUserEnabled, mentionsRoleEnabled, mentionsHereEnabled, mentionsEveryoneEnabled, badgeClickAction, chattingEnabled, messageDisplay, compactModeAvatars, roleColors, mobileZoomScale, splitLayout, paneRoomIds, paneLocks, gridMirror, seenAnnouncements, discordProxyUrl, workspaceLayout, discordBotDm } = req.body;

    // The Discord proxy only makes sense in local mode (the connection leaves the
    // user's own machine). In hosted mode the server IP is fixed, and honouring a
    // user-supplied proxy would be an SSRF vector — so reject it there.
    if (discordProxyUrl !== undefined && isHostedMode()) {
      return res.status(400).json({ error: 'Proxy configuration is only available in the desktop app.' });
    }
    const nextProxy = typeof discordProxyUrl === 'string' ? discordProxyUrl.trim() : '';
    const proxyChanged =
      discordProxyUrl !== undefined &&
      nextProxy !== ((await storage.getConfig(userId)).discordProxyUrl ?? '');

    const config = await storage.updateConfig(userId, {
      ...(discordProxyUrl !== undefined && { discordProxyUrl: nextProxy }),
      ...(globalHighlightedUsers !== undefined && { globalHighlightedUsers }),
      ...(contractDetection !== undefined && { contractDetection }),
      ...(guildColors !== undefined && { guildColors }),
      ...(dmColors !== undefined && { dmColors }),
      ...(telegramColors !== undefined && { telegramColors }),
      ...(enabledGuilds !== undefined && { enabledGuilds }),
      ...(hiddenUsers !== undefined && { hiddenUsers }),
      ...(evmAddressColor !== undefined && { evmAddressColor }),
      ...(solAddressColor !== undefined && { solAddressColor }),
      ...(openInDiscordApp !== undefined && { openInDiscordApp }),
      ...(openInTelegramApp !== undefined && { openInTelegramApp }),
      ...(messageSounds !== undefined && { messageSounds }),
      ...(soundSettings !== undefined && { soundSettings }),
      ...(channelSounds !== undefined && { channelSounds }),
      ...(pushover !== undefined && { pushover }),
      ...(discordBotDm !== undefined && {
        discordBotDm: {
          enabled: Boolean(discordBotDm.enabled),
          triggers: {
            highlightedUser: Boolean(discordBotDm.triggers?.highlightedUser),
            highlightedUserContract: Boolean(discordBotDm.triggers?.highlightedUserContract),
            contract: Boolean(discordBotDm.triggers?.contract),
            keyword: Boolean(discordBotDm.triggers?.keyword),
            missedRunner: Boolean(discordBotDm.triggers?.missedRunner),
          },
        },
      }),
      ...(missedRunner !== undefined && {
        missedRunner: {
          enabled: Boolean(missedRunner.enabled),
          minMultiplier: Math.max(1.25, Math.min(5, Number(missedRunner.minMultiplier) || 1.5)),
          lookbackHours: Math.max(1, Math.min(168, Number(missedRunner.lookbackHours) || 24)),
          cooldownHours: Math.max(1, Math.min(168, Number(missedRunner.cooldownHours) || 24)),
          ...(missedRunner.minMcAtCall != null && Number(missedRunner.minMcAtCall) > 0
            ? { minMcAtCall: Number(missedRunner.minMcAtCall) }
            : {}),
          notifyVia: (['toast', 'pushover', 'both'] as const).includes(missedRunner.notifyVia)
            ? missedRunner.notifyVia
            : 'toast',
        },
      }),
      ...(contractLinkTemplates !== undefined && { contractLinkTemplates }),
      ...(contractClickAction !== undefined && { contractClickAction }),
      ...(showFullContractAddress !== undefined && { showFullContractAddress }),
      ...(autoOpenHighlightedContracts !== undefined && { autoOpenHighlightedContracts }),
      ...(signalConvergenceWindowMinutes !== undefined && {
        signalConvergenceWindowMinutes: Math.max(1, Math.min(240, Number(signalConvergenceWindowMinutes) || 30)),
      }),
      ...(globalKeywordPatterns !== undefined && { globalKeywordPatterns }),
      ...(keywordAlertsEnabled !== undefined && { keywordAlertsEnabled }),
      ...(desktopNotifications !== undefined && { desktopNotifications }),
      ...(toastAlertsEnabled !== undefined && { toastAlertsEnabled: Boolean(toastAlertsEnabled) }),
      ...(toastPosition !== undefined && {
        toastPosition: [
          'top-left', 'top-center', 'top-right',
          'bottom-left', 'bottom-center', 'bottom-right',
          'center',
        ].includes(toastPosition) ? toastPosition : 'top-right',
      }),
      ...(mentionsUserEnabled !== undefined && { mentionsUserEnabled }),
      ...(mentionsRoleEnabled !== undefined && { mentionsRoleEnabled }),
      ...(mentionsHereEnabled !== undefined && { mentionsHereEnabled }),
      ...(mentionsEveryoneEnabled !== undefined && { mentionsEveryoneEnabled }),
      ...(badgeClickAction !== undefined && { badgeClickAction }),
      ...(chattingEnabled !== undefined && { chattingEnabled }),
      ...(messageDisplay !== undefined && { messageDisplay }),
      ...(compactModeAvatars !== undefined && { compactModeAvatars }),
      ...(roleColors !== undefined && { roleColors }),
      ...(mobileZoomScale !== undefined && { mobileZoomScale }),
      ...(splitLayout !== undefined && { splitLayout }),
      ...(paneRoomIds !== undefined && { paneRoomIds }),
      ...(paneLocks !== undefined && { paneLocks }),
      ...(gridMirror !== undefined && { gridMirror }),
      ...(seenAnnouncements !== undefined && { seenAnnouncements }),
      ...(workspaceLayout !== undefined && { workspaceLayout }),
    });

    // Reconnect Discord so the new proxy takes effect immediately (local mode).
    if (proxyChanged) {
      const tokens = await storage.getTokens(userId);
      if (tokens.length > 0) {
        const { connectGateway } = await import('../../index.js');
        connectGateway(tokens, wsServer, userId);
      }
    }

    res.json(config);
  });

  // --- Settings Export / Import ---

  // Discord/Telegram credentials. In hosted mode these are managed/encrypted
  // server-side and must never leave the server. In local mode they are part of
  // a backup so a restore can fully re-establish Discord/Telegram access.
  const CREDENTIAL_CONFIG_KEYS = [
    'discordTokens',
    'telegramSessions',
    'telegramApiId',
    'telegramApiHash',
  ] as const;

  // Machine-generated caches and machine-specific settings that are never part
  // of a settings backup. The proxy URL can embed credentials and is tied to the
  // local network, so it must never be exported or imported.
  const NON_PORTABLE_CONFIG_KEYS = ['userNameCache', 'discordProxyUrl'] as const;

  router.get('/config/export', async (req, res) => {
    const userId = getUserId(req);
    try {
      const fullConfig = await storage.getConfig(userId);
      const rooms = await storage.getRooms(userId);

      const stripKeys: string[] = isHostedMode()
        ? [...CREDENTIAL_CONFIG_KEYS, ...NON_PORTABLE_CONFIG_KEYS]
        : [...NON_PORTABLE_CONFIG_KEYS];

      const exportConfig: Record<string, any> = {};
      for (const [key, value] of Object.entries(fullConfig)) {
        if (stripKeys.includes(key)) continue;
        if (key === 'rooms') continue;
        exportConfig[key] = value;
      }

      if (exportConfig.pushover) {
        const { appToken, userKey, ...safePushover } = exportConfig.pushover;
        exportConfig.pushover = safePushover;
      }

      res.json({
        version: 1,
        exportedAt: new Date().toISOString(),
        config: exportConfig,
        rooms,
      });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to export settings') });
    }
  });

  router.post('/config/import', async (req, res) => {
    const userId = getUserId(req);
    const { config: importedConfig, rooms: importedRooms } = req.body;

    if (!importedConfig || typeof importedConfig !== 'object') {
      return res.status(400).json({ error: 'Invalid import data: missing config object.' });
    }

    try {
      // Credentials are applied separately (and only in local mode); everything
      // else goes through the generic config merge.
      const blockedKeys: string[] = [...CREDENTIAL_CONFIG_KEYS, ...NON_PORTABLE_CONFIG_KEYS, 'rooms'];
      const sanitized: Record<string, any> = {};
      for (const [key, value] of Object.entries(importedConfig)) {
        if (blockedKeys.includes(key)) continue;
        sanitized[key] = value;
      }

      if (sanitized.pushover) {
        const existing = (await storage.getConfig(userId)).pushover;
        sanitized.pushover = {
          ...sanitized.pushover,
          appToken: existing?.appToken ?? '',
          userKey: existing?.userKey ?? '',
        };
      }

      await storage.updateConfig(userId, sanitized);

      if (Array.isArray(importedRooms)) {
        const existingRooms = await storage.getRooms(userId);
        for (const room of existingRooms) {
          await storage.deleteRoom(userId, room.id);
        }
        for (const room of importedRooms) {
          const { id, ...roomData } = room;
          await storage.createRoom(userId, roomData);
        }
      }

      // Local mode: restore Discord/Telegram credentials from the backup and
      // (re)connect. Hosted mode keeps credentials encrypted server-side, so
      // any credentials present in the import are ignored.
      if (!isHostedMode()) {
        const tgUpdate: Record<string, any> = {};
        if (typeof importedConfig.telegramApiId === 'string') {
          tgUpdate.telegramApiId = importedConfig.telegramApiId;
        }
        if (typeof importedConfig.telegramApiHash === 'string') {
          tgUpdate.telegramApiHash = importedConfig.telegramApiHash;
        }
        if (Array.isArray(importedConfig.telegramSessions)) {
          tgUpdate.telegramSessions = importedConfig.telegramSessions.filter(
            (s: unknown) => typeof s === 'string',
          );
        }
        if (Object.keys(tgUpdate).length > 0) {
          await storage.updateConfig(userId, tgUpdate);
        }

        const cfg = await storage.getConfig(userId);
        const numericApiId = parseInt(cfg.telegramApiId ?? '0', 10);
        const apiHash = cfg.telegramApiHash ?? '';
        const sessions = cfg.telegramSessions ?? [];
        if (numericApiId && apiHash && sessions.length > 0) {
          try {
            const { connectTelegram } = await import('../../index.js');
            await connectTelegram(numericApiId, apiHash, sessions, wsServer, userId);
          } catch (err) {
            console.error('[Import] Failed to connect Telegram after import:', err);
          }
        }

        if (Array.isArray(importedConfig.discordTokens)) {
          const validTokens = importedConfig.discordTokens
            .map((t: unknown) => (typeof t === 'string' ? t.trim() : ''))
            .filter(Boolean);
          if (validTokens.length > 0) {
            await storage.setTokens(userId, validTokens);
            try {
              const { connectGateway } = await import('../../index.js');
              connectGateway(validTokens, wsServer, userId);
            } catch (err) {
              console.error('[Import] Failed to connect Discord gateway after import:', err);
            }
          }
        }
      }

      const updatedConfig = await storage.getConfig(userId);
      const { discordTokens, telegramSessions, ...safeConfig } = updatedConfig;
      const updatedRooms = await storage.getRooms(userId);

      res.json({ success: true, config: safeConfig, rooms: updatedRooms });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err, 'Failed to import settings') });
    }
  });

  return router;
}
