import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
// Never let a bundled/empty .env override Railway/Vercel injected secrets.
dotenvConfig({ path: envPath, override: false });
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { GatewayManager } from './discord/gatewayManager.js';
import { createProxyBundle } from './discord/proxy.js';
import { configStore } from './config/store.js';
import { TelegramClientManager } from './telegram/clientManager.js';
import { processTelegramMessage, roomsForTelegramMessage, telegramChannelId } from './telegram/messageProcessor.js';
import type { TelegramRawMessage } from './telegram/types.js';
import type { TelegramMessageProcessorContext } from './telegram/messageProcessor.js';
import { WsServer } from './ws/server.js';
import { createRouter } from './api/routes.js';
import { createBotRouter } from './api/routes/bot.js';
import { createSniperRouter } from './api/sniper/router.js';
import { requireBotAuth } from './auth/botAuth.js';
import { startBot } from './bot/index.js';
import {
  startTelegramBot,
  tgDeliverFlapStock,
  tgDeliverMcapCross,
  tgDeliverOctSignal,
  tgSubscriberCount,
} from './tgbot/index.js';
import { buildOctSignalView } from './tgbot/octSignals.js';
import {
  resolveSignalIngestUserId,
  planSignalIngest,
  signalIngestKeepAlive,
  redactUserId,
} from './tgbot/signalIngest.js';
import { startDailyDigestScheduler } from './bot/dailyDigest.js';
import { getStorageProvider, isHostedMode } from './storage/index.js';
import { authMiddleware } from './auth/middleware.js';
import { getGateway, setGateway } from './gateway/state.js';
import { recordIngest } from './health/ingestHeartbeat.js';
import { buildDeepHealth, collectDeepHealthFacts, deepHealthHttpStatus } from './health/deepHealth.js';
import { UserGatewayPool } from './gateway/userGatewayPool.js';
import { buildContractUrl, detectEvmChainFromContent, extractEvmChainFromGmgnLinks, resolveEvmChainFromApi } from './utils/contract.js';
import { tryParseTokenEnrichment, buildRickReplyContext } from './utils/rickEmbedParser.js';
import { enrichToken, persistEnrichment } from './utils/tokenSnapshot.js';
import { resolveFallbackTarget, recordFallbackFdv } from './utils/dexFallback.js';
import { cacheDiscordMessage } from '@oct/shared';
import type { TokenEnrichment } from './utils/rickEmbedParser.js';
import { processDiscordMessage } from './utils/messageProcessor.js';
import type { MessageProcessorContext } from './utils/messageProcessor.js';
import { sendPushover } from './utils/pushover.js';
import { broadcastFrontendAlerts } from './utils/frontendAlerts.js';
import { startFomoPoller } from './fomo/poller.js';
import { startRobinhoodPoller } from './robinhood/poller.js';
import { startFomoJoinWatcher } from './fomo/joinWatcher.js';
import { startPumpCalloutPoller } from './pumpfun/calloutPoller.js';
import { startJ7Consumer } from './j7/index.js';
import { startWalletMovementPoller } from './wallets/movementPoller.js';
import { startFomoRetentionSweeper } from './fomo/retention.js';
import { startFomoStreamListener } from './fomo/streamListener.js';
import { startMissedRunnerPoller } from './alerts/missedRunnerPoller.js';
import { startRevivalPoller } from './revival/poller.js';
import { startJournalPoller } from './journal/poller.js';
import { startJournalVolumeDeathPoller } from './journal/volumeDeathPoller.js';
import { startPriceAlertPoller } from './priceAlerts/poller.js';
import { startMcapCrossPoller } from './mcapCross/poller.js';
import { startFlapPoller } from './flap/poller.js';
import { startTokenPeakSampler } from './alerts/tokenPeakSampler.js';
import { onPeakRaised } from './alerts/tokenPeakStore.js';
import {
  recordScannedContract,
  scoringExclusions,
  startCallerStatsReconciler,
} from './callers/callerStatsRecorder.js';
import type { DiscordMessage, PushoverConfig, FrontendMessage, ContractLinkTemplates } from './discord/types.js';
import type { ContractEnrichmentPatch } from './utils/contractLog.js';
import { installProcessGuards, guardAsyncHandler } from './utils/processGuards.js';

// Installed here rather than in bootstrap.ts because bootstrap.ts is not the
// only entry point: Railway runs `node dist/bootstrap.js`, but the desktop app
// bundles and forks `backend/dist/index.js` directly.
installProcessGuards();

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const LOCAL_USER_ID = 'local';

// Local mode has no auth at all — every request is the implicit `local` user, and
// the API hands out Discord tokens and Telegram session strings. Binding to every
// interface would put those on the LAN, so local mode listens on loopback only.
// Hosted mode runs behind Railway's proxy and must accept traffic on 0.0.0.0.
// `OCT_HOST` is the deliberate opt-out for anyone self-hosting on a trusted network.
const HOST = process.env.OCT_HOST
  ?? process.env.TRENCHCORD_HOST
  ?? (isHostedMode() ? '0.0.0.0' : '127.0.0.1');

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
  // A Telegram forum-topic message carries `chatId:topicId`; a filter saved for the
  // whole group (bare chatId — every pre-topics filter) must keep matching, so the
  // group half of the id counts too. Discord ids never contain ':', so this is inert there.
  if (
    f.channelIds.length > 0 &&
    !f.channelIds.includes(msg.channelId) &&
    !f.channelIds.includes(msg.channelId.split(':')[0])
  ) return;
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

function enrichmentToPatch(e: TokenEnrichment): ContractEnrichmentPatch {
  return {
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
    firstCallerName: e.firstCallerName,
    firstCallMcapUsd: e.firstCallMcapUsd,
    firstCallAt: e.firstCallAt,
  };
}

async function applyTokenEnrichment(
  wsServer: WsServer,
  userId: string,
  enrichment: TokenEnrichment,
  options?: { channelId?: string; messageId?: string },
): Promise<void> {
  const storage = getStorageProvider();
  const updated = await storage.enrichContract(
    userId,
    enrichment.address,
    enrichmentToPatch(enrichment),
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

/**
 * Schedule a DexScreener/GMGN fallback if Rick doesn't enrich within a few seconds.
 *
 * The patch carries FDV: Telegram has no Rick, so this is the only place a
 * Telegram scan ever gets an MC-at-call. `mergeEnrichmentPatch` keeps a Rick
 * embed authoritative if one lands before or after this runs.
 */
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
      const hit = await resolveFallbackTarget(storage, userId, address, messageId);
      if (!hit) return;
      const enrichment = await enrichToken(address, hit.evmChain);
      // Report the outcome either way: a fetch that comes back without an MC is
      // what stops the next mention of an unpriceable address re-asking.
      recordFallbackFdv(address, enrichment);
      if (!enrichment) return;
      await applyTokenEnrichment(wsServer, userId, enrichment, { channelId, messageId });
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

  gw.on('message', guardAsyncHandler('App:discord-message', async (rawMsg: DiscordMessage & { _channelName: string; _guildName: string | null }) => {
    // Before room gating on purpose: the heartbeat means "the gateway is
    // delivering traffic", not "the traffic matched a room".
    recordIngest();
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
          source: 'discord' as const,
        };
        try {
          const logged = await storage.logContract(userId, entry);
          if (isEvm && evmChainHint) {
            await storage.updateEvmChain(userId, addr, evmChainHint);
          }
          wsServer.broadcastContract(logged, userId);
          // Durable caller record + a debounced peak refresh for this token.
          // Fire-and-forget by design: ranking must never delay or break ingest.
          recordScannedContract(userId, logged, { exclude: scoringExclusions(config) });
          scheduleDexFallback(wsServer, userId, addr, logged.channelId, logged.messageId);
        } catch (err) {
          console.error('[App] Failed to persist contract:', (err as Error).message);
          wsServer.broadcastContract(entry, userId);
          scheduleDexFallback(wsServer, userId, addr, frontendMsg.channelId, frontendMsg.id);
        }
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
      messageTimestamp: rawMsg.timestamp,
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

    broadcastFrontendAlerts(wsServer, userId, frontendMsg, config);

    wsServer.broadcastMessage(frontendMsg, roomIds, userId);
  }));

  gw.on('messageUpdate', guardAsyncHandler('App:discord-message-update', async (rawMsg: Partial<DiscordMessage> & { id: string; channel_id: string; guild_id?: string; _channelName: string; _guildName: string | null }) => {
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
      messageTimestamp: rawMsg.timestamp ?? rawMsg.edited_timestamp ?? undefined,
    });
    if (rickEnrichment) {
      await applyTokenEnrichment(wsServer, userId, rickEnrichment, {
        channelId: rawMsg.channel_id,
        messageId: rickReply.messageId,
      });
    }
  }));

  gw.on('messageDelete', guardAsyncHandler('App:discord-message-delete', async (data: { id: string; channel_id: string; guild_id?: string | null }) => {
    const rooms = await storage.getRoomsForChannel(userId, data.channel_id);
    const isDM = !data.guild_id && gw.getDMChannels().some((dm) => dm.id === data.channel_id);
    if (rooms.length === 0 && !isDM) return;

    const roomIds = rooms.map((r) => r.id);
    if (isDM) roomIds.push(`dm:${data.channel_id}`);

    wsServer.broadcastMessageDelete({
      messageId: data.id,
      channelId: data.channel_id,
    }, roomIds, userId);
  }));

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

  // Rooms a Telegram message routes to — see roomsForTelegramMessage for the topic/group
  // routing rules. One `getRooms` load feeds both predicates; this used to be two parallel
  // `getRoomsForChannel` calls, i.e. two loads of the same room set per topic message on the
  // hottest path in the process.
  const resolveTelegramRooms = async (raw: TelegramRawMessage) =>
    roomsForTelegramMessage(await storage.getRooms(userId), raw.chatId, raw.topicId);

  tg.on('ready', (user: { id: string; username: string | null; firstName: string }) => {
    console.log(`[App] Telegram logged in as ${user.firstName} (@${user.username ?? 'no-username'})`);
    wsServer.broadcastRaw({ type: 'telegram_ready', data: { username: user.username, firstName: user.firstName } }, userId);
  });

  tg.on('message', guardAsyncHandler('App:telegram-message', async (raw: TelegramRawMessage) => {
    // See the Discord handler above: heartbeat before room gating.
    recordIngest();
    const rooms = await resolveTelegramRooms(raw);
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

    // OCT Alerts: if this message came from an operator-configured algorithm
    // source channel (by id, per chain — see tgbot/octSignals.ts), forward it to
    // the bot's subscribers in realtime. Rides the message that already arrived;
    // no added poll, no delay. White-labelled and independent of the rest of the
    // pipeline — it does not depend on room routing or contract persistence.
    //
    // The source is a forum TOPIC of a supergroup, so the recogniser needs the
    // full `chatId:topicId` composite (the same id routing computes), not the
    // bare chat id — otherwise the two algorithm topics are indistinguishable.
    const octSignalChannelId = telegramChannelId(raw.chatId, raw.topicId);
    const octSignal = buildOctSignalView({ chatId: octSignalChannelId, text: raw.text, evmChainHint });
    if (octSignal) tgDeliverOctSignal(octSignal);

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
          source: 'telegram' as const,
        };
        try {
          const logged = await storage.logContract(userId, entry);
          if (isEvm && evmChainHint) {
            await storage.updateEvmChain(userId, addr, evmChainHint);
          }
          wsServer.broadcastContract(logged, userId);
          // Same durable caller record as the Discord path — one pipeline, one
          // board. See recordScannedContract.
          recordScannedContract(userId, logged, { exclude: scoringExclusions(config) });
          scheduleDexFallback(wsServer, userId, addr, logged.channelId, logged.messageId);
        } catch (err) {
          console.error('[App] Failed to persist Telegram contract:', (err as Error).message);
          wsServer.broadcastContract(entry, userId);
          scheduleDexFallback(wsServer, userId, addr, frontendMsg.channelId, frontendMsg.id);
        }
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

    broadcastFrontendAlerts(wsServer, userId, frontendMsg, config);

    wsServer.broadcastMessage(frontendMsg, roomIds, userId);
  }));

  tg.on('messageUpdate', guardAsyncHandler('App:telegram-message-update', async (raw: TelegramRawMessage) => {
    const rooms = await resolveTelegramRooms(raw);
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
  }));

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

// --- OCT Alerts hosted ingest ---
//
// Hosted mode connects gateways per-user on demand, so nothing reads the
// algorithm forum-topics until a console session is open. That is why a scan
// posted after a deploy forwarded nothing. Bring up ONE designated operator
// Telegram session at boot and keep it alive independent of any console
// session, routed through the same `connectTelegram` → `wireTelegramEvents`
// path as every other session, so the octSignal hook is wired identically.
//
// How is it kept alive? Transient drops self-heal inside the client wrapper
// (telegram/client.ts runs an indefinite health-check + backoff reconnect).
// Nothing idle-evicts a hosted Telegram manager (unlike the Discord
// UserGatewayPool), so the session is not on a teardown timer. The watchdog
// below is the belt-and-suspenders: it re-establishes an ingest session that is
// gone ENTIRELY — never connected because no session was stored at boot, or
// explicitly disconnected — without touching healthy or self-reconnecting ones.

/** How often the ingest watchdog checks that keep-alive sessions still exist. */
const SIGNAL_INGEST_WATCHDOG_MS = 5 * 60_000;
let signalIngestWatchdog: ReturnType<typeof setInterval> | null = null;

/**
 * Connect the designated operator ingest session at boot and register it as
 * keep-alive. Fails safe: a missing user id or an unusable session logs one
 * clear line and returns — it never throws into startup. Never logs the
 * session string, api hash, or api id.
 */
export async function startHostedSignalIngest(wsServer: WsServer): Promise<void> {
  const userId = resolveSignalIngestUserId();
  if (!userId) {
    console.log('[App] OCT Alerts ingest: no ingest user configured (set OCT_SIGNAL_INGEST_USER_ID or TG_BOT_ALERT_SOURCE_USER_ID); hosted signal ingest disabled.');
    return;
  }

  // Mark keep-alive BEFORE the connect attempt so the watchdog owns this user
  // even if the boot read finds no session yet.
  signalIngestKeepAlive.mark(userId);

  let config;
  try {
    config = await getStorageProvider().getConfig(userId);
  } catch (err) {
    console.error(`[App] OCT Alerts ingest: could not read config for user ${redactUserId(userId)}: ${(err as Error).message}`);
    startSignalIngestWatchdog(wsServer);
    return;
  }

  const plan = planSignalIngest(userId, config);
  if (plan.action === 'missing-session') {
    console.log(`[App] OCT Alerts ingest: user ${redactUserId(userId)} has no usable Telegram session/apiId/apiHash stored; cannot ingest yet. Store that account's Telegram session and it will connect without a restart.`);
    startSignalIngestWatchdog(wsServer);
    return;
  }
  if (plan.action === 'connect') {
    console.log(`[App] OCT Alerts ingest: connecting Telegram for user ${redactUserId(userId)} (${plan.sessions.length} session(s))...`);
    connectTelegram(plan.apiId, plan.apiHash, plan.sessions, wsServer, userId)
      .then(() => console.log(`[App] OCT Alerts ingest: Telegram connected for user ${redactUserId(userId)}.`))
      .catch((err) => console.error(`[App] OCT Alerts ingest: Telegram connection failed for user ${redactUserId(userId)}: ${(err as Error).message}`));
  }

  startSignalIngestWatchdog(wsServer);
}

function startSignalIngestWatchdog(wsServer: WsServer): void {
  if (signalIngestWatchdog) return;
  signalIngestWatchdog = setInterval(() => {
    void ensureSignalIngestConnected(wsServer);
  }, SIGNAL_INGEST_WATCHDOG_MS);
  signalIngestWatchdog.unref?.();
}

/**
 * Re-establish any keep-alive ingest session that has gone missing. Reads
 * config ONLY when a session is absent (a rare, non-steady-state event), so it
 * adds no per-message or steady-state storage egress.
 */
async function ensureSignalIngestConnected(wsServer: WsServer): Promise<void> {
  const storage = getStorageProvider();
  for (const userId of signalIngestKeepAlive.list()) {
    // A manager that exists — connected, or mid-reconnect inside the client
    // wrapper — is left alone. Only a genuinely absent session is restored.
    if (getUserTelegram(userId)) continue;
    try {
      const plan = planSignalIngest(userId, await storage.getConfig(userId));
      if (plan.action === 'connect') {
        console.log(`[App] OCT Alerts ingest: watchdog reconnecting Telegram for user ${redactUserId(userId)}...`);
        await connectTelegram(plan.apiId, plan.apiHash, plan.sessions, wsServer, userId);
      }
    } catch (err) {
      console.error(`[App] OCT Alerts ingest: watchdog reconnect failed for user ${redactUserId(userId)}: ${(err as Error).message}`);
    }
  }
}

const app = express();

// Railway/Vercel sit behind a reverse proxy — required for express-rate-limit client IP.
if (isHostedMode()) {
  app.set('trust proxy', 1);
}

// Sniper control plane. Mounted FIRST, ahead of the app-wide cors() below, so
// that the CORS policy binding it is its own (api/sniper/auth.ts) and never the
// one configured here. In local mode index.ts falls through to a wildcard
// `app.use(cors())` and auth/middleware.ts sets req.userId = 'local' with no
// credential — together that would let any web page the operator visits author
// an armed rule with caps of its own choosing, and every control in executeFire
// would be intact and irrelevant. The sniper's own layer allows exactly the
// console's origin (loopback in local, ALLOWED_ORIGINS in hosted, fail-closed
// when that is unset) and answers everything else 403 with no CORS headers.
// See docs/architecture/sniper-security.md T12 and ADR-008's limits.
// It carries its own body parser, its own rate limit and its own auth for the
// same reason: it must not inherit anything mounted after this line.
//
// ORDERING CONSTRAINT, for whoever edits this next: createSniperRouter() takes
// no arguments on purpose. Giving it `wsServer` (e.g. to broadcast fire events)
// would force it below `new WsServer(...)`, i.e. below the cors() call it must
// precede. The Fires tab polls instead.
app.use('/sniper/v1', createSniperRouter());

// Response compression for everything mounted below (deliberately NOT the
// sniper control plane above — it inherits nothing from this stack). Railway's
// proxy does not gzip response bodies, so without this every polled JSON
// payload (contracts, caller scores, FOMO trades, journal) leaves the server
// at full size — user-visible latency AND billed Railway egress. The polled
// /api responses are highly repetitive JSON that compresses ~7x (measured:
// GET /api/contracts?limit=500 — 463,220 B identity, 71,124 B gzip, 65,095 B
// brotli, at negligible added latency). Defaults are right for
// us: >1 kB bodies only, compressible content-types only, and WebSocket
// upgrades never touch the middleware stack. There are no SSE/streaming
// responses on this app (they would need res.flush()).
app.use(compression());

// CORS: restrict origins in hosted mode, allow all in local mode.
//
// maxAge matters more than it looks: every console request carries an
// Authorization header, which is not CORS-safelisted, so the browser
// preflights it — and without Access-Control-Max-Age the preflight cache
// defaults to FIVE SECONDS. Every poll cadence in the console (sniper 20s,
// radar/journal/price-alerts 60s, revival 120s) exceeds that, so each poll
// was two round-trips to Railway: OPTIONS, then the real request. Advertising
// a long cache collapses that to one preflight per URL per browser cap
// (Chrome clamps to 2h, Firefox to 24h) — roughly halving polled request
// volume and removing a full cross-origin RTT from each poll's latency.
// Preflight results are keyed per URL and revalidated on any header/method
// change, so a long maxAge is safe: the policy it caches is origin-scoped,
// and origin changes always bypass the cache.
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 86_400;
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
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  }));
} else {
  // Local dev (vite origin → backend origin) preflights JSON POSTs the same
  // way; the desktop app is same-origin and never preflights. Harmless there,
  // cheap here.
  app.use(cors({ maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS }));
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
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    skip: (req) =>
      req.method === 'POST' && req.originalUrl.includes('/alerts/missed-runner/test'),
  });
  app.use('/api', generalLimiter);

  // /health/deep is unauthenticated by design (a monitor should not need a
  // credential), so a limiter is the only thing bounding it. Generous enough for
  // a 10s-interval uptime check plus retries, tight enough that it cannot be
  // scraped in a loop. NOT applied to /health — Railway's own probe polls that
  // one, and a rate-limited liveness probe is a restart storm waiting to happen.
  app.use(
    '/health/deep',
    rateLimit({
      windowMs: 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later.' },
    }),
  );
}

const httpServer = createServer(app);
const wsServer = new WsServer(httpServer);

if (isHostedMode()) {
  wsServer.setUserLifecycleCallbacks(
    (userId) => gatewayPool.markClientConnected(userId),
    (userId) => gatewayPool.markClientDisconnected(userId),
  );
}

// Machine-auth bot API (see docs/architecture/discord-bot.md). Mounted BEFORE the user-auth /api
// router so bot traffic authenticates via OCT_BOT_API_KEY, not Supabase JWTs.
// The hosted-mode /api rate limiter above still covers this prefix.
app.use('/api/v1/bot', requireBotAuth, createBotRouter());

app.use('/api', authMiddleware, createRouter(wsServer));

// LIVENESS. Railway polls THIS (railway.toml `healthcheckPath = "/health"`) and
// its restart policy is ON_FAILURE, so it must never report on subsystems: a
// degraded FOMO worker returning non-200 here would make Railway restart the
// container into the same degradation, forever. Keep it a dumb 200.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// READINESS — a separate path precisely so it is allowed to fail. Returns 503
// when a subsystem is degraded; intended for an external uptime monitor only.
// Do NOT point railway.toml's healthcheckPath at it. Rationale in full:
// backend/src/health/deepHealth.ts.
app.get('/health/deep', (_req, res) => {
  const hosted = isHostedMode();
  const localGateway = hosted ? null : getGateway();
  const report = buildDeepHealth(
    collectDeepHealthFacts({
      // Boolean, never the pooled count. This endpoint is unauthenticated, so
      // publishing gatewayPool.getActiveCount() told any anonymous caller how
      // many people were using OCT at that moment. A monitor needs up/down.
      connected: hosted ? gatewayPool.getActiveCount() > 0 : localGateway !== null,
      invalidTokens: hosted ? null : (localGateway?.getInvalidTokenIndices().length ?? 0),
    }),
  );
  res.status(deepHealthHttpStatus(report)).json(report);
});

const frontendDist = process.env.OCT_FRONTEND_DIST || process.env.TRENCHCORD_FRONTEND_DIST || path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

httpServer.listen(PORT, HOST, async () => {
  console.log(`[App] Server running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`[App] Mode: ${isHostedMode() ? 'hosted' : 'local'} (bound to ${HOST})`);
  if (!isHostedMode() && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(`[App] WARNING: local mode is listening on ${HOST} with no authentication. Anyone who can reach this port can read your Discord tokens and Telegram sessions.`);
  }

  // Global FOMO fan-out poller. Self-gates: idle without a shared FOMO service
  // account (FOMO_REFRESH_TOKEN) or Supabase, so this never crashes the server.
  startFomoPoller(wsServer);
  // Global FOMO new-join watcher (notable accounts joining fomo.family IS the
  // signal). Self-gates exactly like the poller above: idle without Supabase
  // or the shared FOMO refresh token.
  startFomoJoinWatcher(wsServer);
  // Robinhood Chain live tape (robinhoodtrenches, keyless). Opt-in via
  // OCT_ROBINHOOD_ENABLED; broadcasts `robinhood_fill` on the existing WS.
  // Self-gates and never throws — a third-party outage parks the interval.
  startRobinhoodPoller(wsServer);
  // All-chain FOMO tape re-broadcast by 985monitor.xyz (public SSE, keyless).
  // Opt-in via OCT_FOMO_STREAM_ENABLED; broadcasts `fomo_stream_trade` on the
  // existing WS. Its own labelled signal — never fused with the fomo.family
  // feed above or with OCT convergence.
  startFomoStreamListener(wsServer);
  // Keeps the FOMO trade log from growing without bound; the console only ever
  // replays the last day of it.
  startFomoRetentionSweeper();
  startMissedRunnerPoller(wsServer);
  // Revival ignition alerts (ATR-gate detector over GeckoTerminal candles).
  // Runs in BOTH modes: local reads the JSON contract log, hosted the contracts
  // table. Keyless upstream, in-memory cooldowns, gated by OCT_REVIVAL_ENABLED.
  startRevivalPoller(wsServer);
  // Trade journal: own-wallet swap ingestion (Helius) + FIFO position pairing.
  // Runs in BOTH modes; self-gates on HELIUS_API_KEY (idle without it).
  startJournalPoller(wsServer);
  // "Meta dying" volume-collapse alerts for OPEN journal positions. Keyless
  // DexScreener upstream; an independent signal, never fused with revival.
  startJournalVolumeDeathPoller(wsServer);
  // Operator-set price/mcap levels → alert on CROSSING. Runs in BOTH modes,
  // keyless DexScreener upstream, and self-gates on there being at least one
  // armed alert (zero armed = zero requests). Its own independent signal:
  // no detection, no scoring, never fused with revival/breakout/missed-runner.
  startPriceAlertPoller(wsServer);
  // Chain-wide market-cap crossings ($750K on Solana/BNB/Robinhood, scam-gated).
  // Its own independent signal — never fused with revival, breakout,
  // missed-runner, convergence or FOMO. Self-gates HARD: with no Telegram chat
  // subscribed it makes zero upstream requests, so the chain-wide sweep costs
  // nothing until somebody deliberately opts in. Delivery is injected rather
  // than imported so mcapCross/ never reaches into tgbot/.
  startMcapCrossPoller(wsServer, {
    hasSubscribers: async () => (await tgSubscriberCount('mcapCross')) > 0,
    // The verdict travels with the payload so the bot can apply the OWNER's
    // per-user filters per chat (tg_bot_chats.source_user_id → an OCT user).
    // A chat that resolves to nobody falls back to `baselinePass`, i.e. exactly
    // what it received before per-user filters existed.
    deliver: (data, verdict) =>
      tgDeliverMcapCross(
        {
          address: data.address,
          network: data.network,
          symbol: data.symbol,
          mcapUsd: data.mcapUsd,
          targetUsd: data.targetUsd,
          liquidityUsd: data.liquidityUsd,
          liquidityRatio: data.liquidityRatio,
          volume24hUsd: data.volume24hUsd,
          totalFeesUsd: data.totalFeesUsd,
          caveats: data.caveats,
        },
        verdict,
      ),
  });
  // Flap RWA-stock listing watcher (a brand-new underlying stock on BNB /
  // Robinhood, deduped on the RWA asset — NOT every meme launch). Its own
  // independent signal, never fused. Self-gates HARD like mcapCross: with no
  // Telegram chat subscribed it makes zero RPC requests. BNB works out of the
  // box (Pinax/PINAX_API_KEY); Robinhood only when its RPC + VaultPortal env are
  // set. Delivery injected so flap/ never reaches into tgbot/.
  startFlapPoller({
    hasSubscribers: async () => (await tgSubscriberCount('flapStock')) > 0,
    deliver: (data) =>
      tgDeliverFlapStock({
        symbols: data.symbols,
        network: data.network,
        firstTokenAddress: data.firstTokenAddress,
      }),
  });
  // Global pump.fun KOL-callout fan-out poller. Self-gates on Supabase (idle in
  // local mode), keyless upstream, so it never crashes the server.
  startPumpCalloutPoller(wsServer);
  // In-process j7tracker socket consumer — recovers the dead fomo.family + pump
  // callout upstreams and re-emits them as the existing pump_callout/fomo_trade
  // frames. Self-gates on J7_JWTS_JSON (idle without JWTs), so it never crashes
  // the server; runs in BOTH modes (env-gated, not Supabase-gated).
  startJ7Consumer(wsServer);
  // On-chain buy/sell alerter for Directory (user_tracked_wallets) SOLANA wallets.
  // Self-gates on Supabase (idle in local mode), keyless upstream (profile-api),
  // so it never crashes the server.
  startWalletMovementPoller(wsServer);

  // Records token high-water market caps, which caller quality scores read.
  // Runs in both modes — local keeps peaks in a JSON file so the desktop app
  // scores callers too.
  startTokenPeakSampler();

  // Push every genuine peak raise to the console so contract rows update their
  // "call MC → peak MC" readout live. A peak is a global market fact about a
  // token — no user data in the frame — so it goes to every connected client
  // rather than being routed per user.
  onPeakRaised((peak) => {
    wsServer.broadcastRaw({
      type: 'token_peak',
      data: {
        address: peak.address,
        chain: peak.chain,
        evmChain: peak.evmChain,
        peakMc: peak.peakMc,
        peakAt: peak.peakAt,
      },
    });
  });

  // Keeps the durable per-caller call record in step with the contract log. The
  // ingest hook writes each call the moment it is scanned; this sweep re-folds
  // recent rows so an MC@call that arrived later, via enrichment, lands on the
  // call it belongs to. Idles when there is no persistent store (local mode),
  // where scores still derive on read.
  startCallerStatsReconciler();

  // In-process OCT Discord bot. Self-gates on DISCORD_BOT_TOKEN and swallows
  // its own failures, so it can never take the backend down.
  startBot(wsServer);

  // In-process OCT Telegram bot (Bot API long-polling — NOT the MTProto
  // ingestion client in telegram/). Delivers alerts into a Telegram group with
  // no credential handover from the user. Self-gates on TELEGRAM_BOT_TOKEN and
  // swallows its own failures, exactly like the Discord bot above.
  startTelegramBot(wsServer);

  // Once-a-day signal digest DMs (opt-in). Self-gates on Supabase + the bot
  // token; if the process was down at the scheduled hour it waits for the next
  // one rather than sending a stale digest on boot.
  startDailyDigestScheduler();

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
    // OCT Alerts is the exception: its MTProto source is infrastructure, not an
    // on-demand user session, so it must be up regardless of any open console.
    await startHostedSignalIngest(wsServer);
  }
});
