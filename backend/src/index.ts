import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __envDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__envDir, '../.env');
// Never let a bundled/empty .env override Railway/Vercel injected secrets.
dotenvConfig({ path: envPath, override: false });
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { GatewayManager } from './discord/gatewayManager.js';
import { createProxyBundle } from './discord/proxy.js';
import { configStore } from './config/store.js';
import { TelegramClientManager } from './telegram/clientManager.js';
import { processTelegramMessage } from './telegram/messageProcessor.js';
import type { TelegramRawMessage } from './telegram/types.js';
import type { TelegramMessageProcessorContext } from './telegram/messageProcessor.js';
import { WsServer } from './ws/server.js';
import { createRouter } from './api/routes.js';
import { getStorageProvider, isHostedMode } from './storage/index.js';
import { authMiddleware } from './auth/middleware.js';
import { getGateway, setGateway } from './gateway/state.js';
import { UserGatewayPool } from './gateway/userGatewayPool.js';
import { buildContractUrl, detectEvmChainFromContent, extractEvmChainFromGmgnLinks, resolveEvmChainFromApi } from './utils/contract.js';
import { tryParseTokenEnrichment, buildRickReplyContext } from './utils/rickEmbedParser.js';
import { enrichToken, persistEnrichment } from './utils/tokenSnapshot.js';
import { needsMetadataFallback, metadataOnlyEnrichmentPatch } from './utils/enrichmentMerge.js';
import { cacheDiscordMessage } from './utils/messageReplyCache.js';
import type { TokenEnrichment } from './utils/rickEmbedParser.js';
import { processDiscordMessage } from './utils/messageProcessor.js';
import type { MessageProcessorContext } from './utils/messageProcessor.js';
import { sendPushover } from './utils/pushover.js';
import { startFomoPoller } from './fomo/poller.js';
import { startMissedRunnerPoller } from './alerts/missedRunnerPoller.js';
import type { DiscordMessage, PushoverConfig, FrontendMessage, ContractLinkTemplates } from './discord/types.js';
import type { ContractEnrichmentPatch } from './utils/contractLog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const LOCAL_USER_ID = 'local';

const gatewayPool = new UserGatewayPool();

// Telegram state
let localTelegramManager: TelegramClientManager | null = null;
const telegramManagers = new Map<string, TelegramClientManager>();

function checkPushover(cfg: PushoverConfig, msg: FrontendMessage, evmChainHint: string | null, contractLinkTemplates: ContractLinkTemplates): void {
  if (!cfg.enabled || !cfg.appToken || !cfg.userKey) return;

  const t = cfg.triggers ?? { highlightedUser: false, highlightedUserContract: true, contract: false, keyword: false, signalConvergence: false, missedRunner: false };
  const f = cfg.filters ?? { userIds: [], channelIds: [], guildIds: [] };

  const triggered =
    (t.highlightedUserContract && msg.isHighlighted && msg.hasContractAddress) ||
    (t.highlightedUser && msg.isHighlighted) ||
    (t.contract && msg.hasContractAddress) ||
    (t.keyword && msg.matchedKeywords && msg.matchedKeywords.length > 0);

  if (!triggered) return;

  if (f.userIds.length > 0 && !f.userIds.includes(msg.author.id)) return;
  if (f.channelIds.length > 0 && !f.channelIds.includes(msg.channelId)) return;
  if (f.guildIds.length > 0 && msg.guildId && !f.guildIds.includes(msg.guildId)) return;

  let title: string;
  let message: string;
  let url: string | undefined;
  let urlTitle: string | undefined;

  if (msg.hasContractAddress) {
    const addr = msg.contractAddresses[0];
    url = buildContractUrl(addr, contractLinkTemplates, evmChainHint ?? undefined);
    urlTitle = 'Open in Explorer';
    title = `Contract Alert: ${msg.author.displayName}`;
    message = `${msg.author.displayName} posted ${addr} in #${msg.channelName}`;
  } else if (msg.matchedKeywords && msg.matchedKeywords.length > 0) {
    title = `Keyword: ${msg.matchedKeywords[0]}`;
    message = `${msg.author.displayName} in #${msg.channelName}: ${msg.content.slice(0, 120)}`;
  } else {
    title = `${msg.author.displayName}`;
    message = `Message in #${msg.channelName}: ${msg.content.slice(0, 120)}`;
  }

  sendPushover(cfg, { title, message, url, urlTitle });
}

// When a message carries no chain hint, resolve the real chain for each EVM
// address via external liquidity APIs and backfill it. Runs in the background
// (never awaited on the message path) and broadcasts a chain_update once known.
function backfillEvmChainsFromApi(
  wsServer: WsServer,
  userId: string,
  addresses: string[],
  evmChainHint: string | null,
): void {
  if (evmChainHint) return;
  const storage = getStorageProvider();
  for (const addr of addresses) {
    if (!addr.startsWith('0x')) continue;
    resolveEvmChainFromApi(addr)
      .then(async (resolved) => {
        if (!resolved) return;
        const updated = await storage.updateEvmChain(userId, addr, resolved);
        if (updated) wsServer.broadcastChainUpdate(addr, resolved, userId);
      })
      .catch((err) => console.error('[App] EVM chain backfill failed:', err.message));
  }
}

function enrichmentToPatch(e: TokenEnrichment, opts?: { metadataOnly?: boolean }): ContractEnrichmentPatch {
  const patch: ContractEnrichmentPatch = {
    tokenName: e.tokenName,
    tokenSymbol: e.tokenSymbol,
    tokenPair: e.tokenPair,
    description: e.description,
    fdvAtCall: e.fdvAtCall,
    fdvAtCallDisplay: e.fdvAtCallDisplay,
    liquidityUsd: e.liquidityUsd,
    liquidityDisplay: e.liquidityDisplay,
    volumeUsd: e.volumeUsd,
    volumeDisplay: e.volumeDisplay,
    priceUsd: e.priceUsd,
    tokenAge: e.tokenAge,
    evmChain: e.evmChain,
    enrichmentSource: e.enrichmentSource,
    enrichedAt: new Date().toISOString(),
  };
  return opts?.metadataOnly ? metadataOnlyEnrichmentPatch(patch) : patch;
}

async function applyTokenEnrichment(
  wsServer: WsServer,
  userId: string,
  enrichment: TokenEnrichment,
  options?: { channelId?: string; messageId?: string },
  patchOpts?: { metadataOnly?: boolean },
): Promise<void> {
  const storage = getStorageProvider();
  const updated = await storage.enrichContract(
    userId,
    enrichment.address,
    enrichmentToPatch(enrichment, patchOpts),
    options,
  );
  if (updated) {
    wsServer.broadcastContractEnrichment(updated, userId);
    void persistEnrichment(enrichment, enrichment.evmChain);
    if (enrichment.evmChain) {
      const chained = await storage.updateEvmChain(userId, enrichment.address, enrichment.evmChain);
      if (chained) wsServer.broadcastChainUpdate(enrichment.address, enrichment.evmChain, userId);
    }
  }
}

/** Schedule DexScreener fallback if Rick doesn't enrich within a few seconds. */
function scheduleDexFallback(
  wsServer: WsServer,
  userId: string,
  address: string,
  channelId: string,
  messageId: string,
): void {
  setTimeout(async () => {
    try {
      const storage = getStorageProvider();
      const recent = await storage.getContracts(userId, 20);
      const hit = recent.find(
        (c) =>
          c.messageId === messageId
          && c.address.toLowerCase() === address.toLowerCase()
          && needsMetadataFallback(c),
      );
      if (!hit) return;
      const enrichment = await enrichToken(address, hit.evmChain);
      if (!enrichment) return;
      await applyTokenEnrichment(wsServer, userId, enrichment, { channelId, messageId }, { metadataOnly: true });
    } catch (err) {
      console.error('[App] Dex fallback failed:', (err as Error).message);
    }
  }, 15_000);
}

function wireGatewayEvents(gw: GatewayManager, wsServer: WsServer, userId: string): void {
  const storage = getStorageProvider();

  gw.on('ready', (user) => {
    console.log(`[App] Logged in as ${user.username}`);
    wsServer.broadcastRaw({ type: 'gateway_ready', data: { username: user.username } }, userId);
  });

  gw.on('message', async (rawMsg: DiscordMessage & { _channelName: string; _guildName: string | null }) => {
    const isDM = !rawMsg.guild_id && gw.getDMChannels().some((dm) => dm.id === rawMsg.channel_id);
    const rooms = await storage.getRoomsForChannel(userId, rawMsg.channel_id);

    if (rooms.length === 0 && !isDM) return;

    cacheDiscordMessage(rawMsg);

    const config = await storage.getConfig(userId);
    const isHighlighted = await storage.isUserHighlighted(userId, rawMsg.author.id);
    const ctx: MessageProcessorContext = {
      config,
      isHighlighted,
      cacheUserName: (discordUserId, displayName) => {
        storage.cacheUserName(userId, discordUserId, displayName);
      },
    };

    const roomKeywords = rooms.flatMap((r) => r.keywordPatterns ?? []);
    const frontendMsg = processDiscordMessage(gw, rawMsg, rawMsg._channelName, rawMsg._guildName, roomKeywords, ctx);
    const evmChainHint = detectEvmChainFromContent(rawMsg.content, rawMsg.embeds);

    checkPushover(config.pushover, frontendMsg, evmChainHint, config.contractLinkTemplates);

    const roomIds = rooms.map((r) => r.id);
    if (isDM) {
      roomIds.push(`dm:${rawMsg.channel_id}`);
    }

    // Mentions: collect guild messages where the logged-in user / their role / @here / @everyone
    // was mentioned, per enabled settings, into a virtual "mentions" room.
    if (rawMsg.guild_id) {
      const selfIds = gw.getSelfUserIds();
      if (!selfIds.has(rawMsg.author.id)) {
        const mentionTypes: ('user' | 'role' | 'here' | 'everyone')[] = [];
        if (config.mentionsUserEnabled && rawMsg.mentions?.some((u) => selfIds.has(u.id))) {
          mentionTypes.push('user');
        }
        if (rawMsg.mention_everyone) {
          if (config.mentionsHereEnabled && rawMsg.content.includes('@here')) mentionTypes.push('here');
          if (config.mentionsEveryoneEnabled && rawMsg.content.includes('@everyone')) mentionTypes.push('everyone');
        }
        if (config.mentionsRoleEnabled && rawMsg.mention_roles && rawMsg.mention_roles.length > 0) {
          const selfRoles = await gw.getSelfRoleIds(rawMsg.guild_id);
          if (rawMsg.mention_roles.some((r) => selfRoles.has(r))) mentionTypes.push('role');
        }
        if (mentionTypes.length > 0) {
          frontendMsg.mentionTypes = mentionTypes;
          roomIds.push('mentions');
        }
      }
    }

    if (frontendMsg.hasContractAddress) {
      for (const addr of frontendMsg.contractAddresses) {
        const isEvm = addr.startsWith('0x');
        const entry = {
          address: addr,
          chain: (isEvm ? 'evm' : 'sol') as 'evm' | 'sol',
          evmChain: isEvm ? (evmChainHint ?? undefined) : undefined,
          authorId: frontendMsg.author.id,
          authorName: frontendMsg.author.displayName,
          channelId: frontendMsg.channelId,
          channelName: frontendMsg.channelName,
          guildId: frontendMsg.guildId,
          guildName: frontendMsg.guildName,
          roomIds,
          messageId: frontendMsg.id,
          timestamp: frontendMsg.timestamp,
        };
        try {
          await storage.logContract(userId, entry);
          if (isEvm && evmChainHint) {
            await storage.updateEvmChain(userId, addr, evmChainHint);
          }
        } catch (err) {
          console.error('[App] Failed to persist contract:', (err as Error).message);
        }
        // Always broadcast so the live feed updates even if DB write fails
        wsServer.broadcastContract(entry, userId);
        scheduleDexFallback(wsServer, userId, addr, frontendMsg.channelId, frontendMsg.id);
      }
      backfillEvmChainsFromApi(wsServer, userId, frontendMsg.contractAddresses, evmChainHint);
    }

    const rickReply = buildRickReplyContext(rawMsg.referenced_message, rawMsg.message_reference);
    const rickEnrichment = tryParseTokenEnrichment({
      embeds: rawMsg.embeds,
      content: rawMsg.content,
      authorUsername: rawMsg.author?.username,
      addressOverride: rickReply.addressOverride,
      callerName: rickReply.callerName,
    });
    if (rickEnrichment) {
      await applyTokenEnrichment(wsServer, userId, rickEnrichment, {
        channelId: rawMsg.channel_id,
        messageId: rickReply.messageId,
      });
    }

    const gmgnChainUpdates = extractEvmChainFromGmgnLinks(rawMsg.content, rawMsg.embeds);
    for (const { address, chain: detectedChain } of gmgnChainUpdates) {
      const updated = await storage.updateEvmChain(userId, address, detectedChain);
      if (updated) {
        wsServer.broadcastChainUpdate(address, detectedChain, userId);
      }
    }

    if (frontendMsg.matchedKeywords && frontendMsg.matchedKeywords.length > 0) {
      wsServer.broadcastAlert({
        type: 'keyword_match',
        message: frontendMsg,
        reason: `Keyword match: ${frontendMsg.matchedKeywords.join(', ')}`,
      }, userId);
    }

    wsServer.broadcastMessage(frontendMsg, roomIds, userId);
  });

  gw.on('messageUpdate', async (rawMsg: Partial<DiscordMessage> & { id: string; channel_id: string; guild_id?: string; _channelName: string; _guildName: string | null }) => {
    const rooms = await storage.getRoomsForChannel(userId, rawMsg.channel_id);
    const isDM = !rawMsg.guild_id && gw.getDMChannels().some((dm) => dm.id === rawMsg.channel_id);
    if (rooms.length === 0 && !isDM) return;

    const roomIds = rooms.map((r) => r.id);
    if (isDM) roomIds.push(`dm:${rawMsg.channel_id}`);

    wsServer.broadcastMessageUpdate({
      messageId: rawMsg.id,
      channelId: rawMsg.channel_id,
      embeds: rawMsg.embeds,
      content: rawMsg.content,
      attachments: rawMsg.attachments,
      editedTimestamp: rawMsg.edited_timestamp ?? null,
    }, roomIds, userId);

    cacheDiscordMessage(rawMsg);

    const rickReply = buildRickReplyContext(rawMsg.referenced_message, rawMsg.message_reference);
    const rickEnrichment = tryParseTokenEnrichment({
      embeds: rawMsg.embeds,
      content: rawMsg.content,
      authorUsername: rawMsg.author?.username,
      addressOverride: rickReply.addressOverride,
      callerName: rickReply.callerName,
    });
    if (rickEnrichment) {
      await applyTokenEnrichment(wsServer, userId, rickEnrichment, {
        channelId: rawMsg.channel_id,
        messageId: rickReply.messageId,
      });
    }
  });

  gw.on('messageDelete', async (data: { id: string; channel_id: string; guild_id?: string | null }) => {
    const rooms = await storage.getRoomsForChannel(userId, data.channel_id);
    const isDM = !data.guild_id && gw.getDMChannels().some((dm) => dm.id === data.channel_id);
    if (rooms.length === 0 && !isDM) return;

    const roomIds = rooms.map((r) => r.id);
    if (isDM) roomIds.push(`dm:${data.channel_id}`);

    wsServer.broadcastMessageDelete({
      messageId: data.id,
      channelId: data.channel_id,
    }, roomIds, userId);
  });

  gw.on('reactionUpdate', (data) => {
    wsServer.broadcastReactionUpdate(data, userId);
  });

  gw.on('fatal', (err: Error) => {
    console.error('[App] Fatal gateway error:', err.message);
  });

  gw.on('auth_failed', (failure: { tokenIndex: number; message: string; invalid: boolean; blocked?: boolean }) => {
    const tokenNumber = failure.tokenIndex + 1;
    // A block is an IP/network problem, not a per-token issue, so skip the
    // "Token #N:" prefix that would wrongly imply the token is at fault.
    const error = failure.blocked ? failure.message : `Token #${tokenNumber}: ${failure.message}`;
    console.error('[App] Discord gateway connection failed:', error);
    wsServer.broadcastRaw(
      { type: 'gateway_auth_failed', error, tokenIndex: failure.tokenIndex, tokenInvalid: failure.invalid, tokenBlocked: failure.blocked ?? false },
      userId,
    );
  });
}

export function connectGateway(tokens: string[], wsServer: WsServer, userId: string = LOCAL_USER_ID): GatewayManager {
  if (isHostedMode()) {
    return gatewayPool.getOrCreate(userId, tokens, (gw) => {
      wireGatewayEvents(gw, wsServer, userId);
    });
  }

  // Local mode: single global gateway. The Discord connection originates from
  // the user's own machine/IP, so an optional proxy lets VPN-blocked users route
  // gateway + REST traffic through a residential/HTTP proxy.
  const existing = getGateway();
  if (existing) {
    existing.disconnect();
  }
  const proxy = createProxyBundle(configStore.getConfig().discordProxyUrl);
  const gw = new GatewayManager(tokens, proxy);
  setGateway(gw);
  wireGatewayEvents(gw, wsServer, userId);
  gw.connect();
  return gw;
}

export function disconnectGateway(userId: string = LOCAL_USER_ID): void {
  if (isHostedMode()) {
    gatewayPool.disconnect(userId);
  } else {
    const gw = getGateway();
    if (gw) gw.disconnect();
    setGateway(null);
  }
}

export function getUserGateway(userId: string): GatewayManager | null {
  if (isHostedMode()) {
    return gatewayPool.get(userId);
  }
  return getGateway();
}

// --- Telegram ---

function wireTelegramEvents(tg: TelegramClientManager, wsServer: WsServer, userId: string): void {
  const storage = getStorageProvider();

  tg.on('ready', (user: { id: string; username: string | null; firstName: string }) => {
    console.log(`[App] Telegram logged in as ${user.firstName} (@${user.username ?? 'no-username'})`);
    wsServer.broadcastRaw({ type: 'telegram_ready', data: { username: user.username, firstName: user.firstName } }, userId);
  });

  tg.on('message', async (raw: TelegramRawMessage) => {
    const rooms = await storage.getRoomsForChannel(userId, raw.chatId);
    const isTgDm = raw.chatType === 'user';

    if (rooms.length === 0 && !isTgDm) return;

    const config = await storage.getConfig(userId);
    const isHighlighted = await storage.isUserHighlighted(userId, raw.sender.id, undefined, raw.sender.username);
    const ctx: TelegramMessageProcessorContext = {
      config,
      isHighlighted,
      cacheUserName: (telegramUserId, displayName) => {
        storage.cacheUserName(userId, telegramUserId, displayName);
      },
    };

    const roomKeywords = rooms.flatMap((r) => r.keywordPatterns ?? []);
    const frontendMsg = processTelegramMessage(raw, roomKeywords, ctx);
    const evmChainHint = detectEvmChainFromContent(raw.text, []);

    checkPushover(config.pushover, frontendMsg, evmChainHint, config.contractLinkTemplates);

    const roomIds = rooms.map((r) => r.id);
    if (isTgDm) {
      roomIds.push(`tg-dm:${raw.chatId}`);
    }

    if (frontendMsg.hasContractAddress) {
      for (const addr of frontendMsg.contractAddresses) {
        const isEvm = addr.startsWith('0x');
        const entry = {
          address: addr,
          chain: (isEvm ? 'evm' : 'sol') as 'evm' | 'sol',
          evmChain: isEvm ? (evmChainHint ?? undefined) : undefined,
          authorId: frontendMsg.author.id,
          authorName: frontendMsg.author.displayName,
          channelId: frontendMsg.channelId,
          channelName: frontendMsg.channelName,
          guildId: frontendMsg.guildId,
          guildName: frontendMsg.guildName,
          roomIds,
          messageId: frontendMsg.id,
          timestamp: frontendMsg.timestamp,
        };
        try {
          await storage.logContract(userId, entry);
          if (isEvm && evmChainHint) {
            await storage.updateEvmChain(userId, addr, evmChainHint);
          }
        } catch (err) {
          console.error('[App] Failed to persist Telegram contract:', (err as Error).message);
        }
        wsServer.broadcastContract(entry, userId);
      }
      backfillEvmChainsFromApi(wsServer, userId, frontendMsg.contractAddresses, evmChainHint);
    }

    if (frontendMsg.matchedKeywords && frontendMsg.matchedKeywords.length > 0) {
      wsServer.broadcastAlert({
        type: 'keyword_match',
        message: frontendMsg,
        reason: `Keyword match: ${frontendMsg.matchedKeywords.join(', ')}`,
      }, userId);
    }

    wsServer.broadcastMessage(frontendMsg, roomIds, userId);
  });

  tg.on('messageUpdate', async (raw: TelegramRawMessage) => {
    const rooms = await storage.getRoomsForChannel(userId, raw.chatId);
    const isTgDm = raw.chatType === 'user';
    if (rooms.length === 0 && !isTgDm) return;

    const roomIds = rooms.map((r) => r.id);
    if (isTgDm) roomIds.push(`tg-dm:${raw.chatId}`);

    const frontendMsg = processTelegramMessage(raw);
    wsServer.broadcastMessageUpdate({
      messageId: frontendMsg.id,
      channelId: frontendMsg.channelId,
      content: frontendMsg.content,
    }, roomIds, userId);
  });

  tg.on('fatal', (err: Error) => {
    console.error('[App] Fatal Telegram error:', err.message);
  });
}

export async function connectTelegram(
  apiId: number,
  apiHash: string,
  sessions: string[],
  wsServer: WsServer,
  userId: string = LOCAL_USER_ID,
): Promise<TelegramClientManager> {
  // Disconnect existing
  disconnectTelegram(userId);

  const tg = new TelegramClientManager(apiId, apiHash, sessions);
  wireTelegramEvents(tg, wsServer, userId);
  await tg.connect();

  if (isHostedMode()) {
    telegramManagers.set(userId, tg);
  } else {
    localTelegramManager = tg;
  }

  return tg;
}

export function disconnectTelegram(userId: string = LOCAL_USER_ID): void {
  if (isHostedMode()) {
    const tg = telegramManagers.get(userId);
    if (tg) {
      tg.disconnect();
      telegramManagers.delete(userId);
    }
  } else {
    if (localTelegramManager) {
      localTelegramManager.disconnect();
      localTelegramManager = null;
    }
  }
}

export function getUserTelegram(userId: string): TelegramClientManager | null {
  if (isHostedMode()) {
    return telegramManagers.get(userId) ?? null;
  }
  return localTelegramManager;
}

const app = express();

// CORS: restrict origins in hosted mode, allow all in local mode
if (isHostedMode()) {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [];
  app.use(cors({
    origin: allowedOrigins.length > 0
      ? (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(new Error('Not allowed by CORS'));
          }
        }
      : true,
    credentials: true,
  }));
} else {
  app.use(cors());
}

// Security headers in hosted mode
if (isHostedMode()) {
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
}

app.use(express.json());

// Rate limiting on auth endpoints in hosted mode
if (isHostedMode()) {
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use('/api/auth', authLimiter);

  const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use('/api', generalLimiter);
}

const httpServer = createServer(app);
const wsServer = new WsServer(httpServer);

if (isHostedMode()) {
  wsServer.setUserLifecycleCallbacks(
    (userId) => gatewayPool.markClientConnected(userId),
    (userId) => gatewayPool.markClientDisconnected(userId),
  );
}

app.use('/api', authMiddleware, createRouter(wsServer));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const frontendDist = process.env.OCT_FRONTEND_DIST || process.env.TRENCHCORD_FRONTEND_DIST || path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

httpServer.listen(PORT, async () => {
  console.log(`[App] Server running on http://localhost:${PORT}`);
  console.log(`[App] Mode: ${isHostedMode() ? 'hosted' : 'local'}`);

  // Global FOMO fan-out poller. Self-gates: idle without a shared FOMO service
  // account (FOMO_REFRESH_TOKEN) or Supabase, so this never crashes the server.
  startFomoPoller(wsServer);
  startMissedRunnerPoller(wsServer);

  if (!isHostedMode()) {
    const storage = getStorageProvider();
    const tokens = await storage.getTokens(LOCAL_USER_ID);
    if (tokens.length > 0) {
      console.log(`[App] Found ${tokens.length} Discord token(s), connecting...`);
      connectGateway(tokens, wsServer, LOCAL_USER_ID);
    } else {
      console.log('[App] No Discord tokens configured. Waiting for token setup via frontend.');
    }

    const config = await storage.getConfig(LOCAL_USER_ID);
    if (config.telegramSessions?.length && config.telegramApiId && config.telegramApiHash) {
      console.log(`[App] Found ${config.telegramSessions.length} Telegram session(s), connecting...`);
      connectTelegram(
        parseInt(config.telegramApiId),
        config.telegramApiHash,
        config.telegramSessions,
        wsServer,
        LOCAL_USER_ID,
      ).catch((err) => console.error('[App] Telegram connection failed:', err.message));
    }
  } else {
    console.log('[App] Hosted mode: gateways will connect per-user on demand.');
  }
});
