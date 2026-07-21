import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { isHostedMode } from '../lib/supabase';
import {
  connectClientGateway,
  disconnectClientGateway,
  getClientGatewayManager,
  isClientGatewayMode,
} from '../discord/clientGateway';
import { getLocalDiscordTokens } from '../discord/tokenStore';
import { processDiscordMessage } from '../discord/processMessage';
import type { GatewayManager } from '../discord/gatewayManager';
import type { DiscordMessage } from '../discord/types';
import type { ContractEntry, FrontendMessage, FrontendReaction, Room } from '../types';
import { playHighlightSound, playContractAlertSound, playKeywordAlertSound } from '../utils/notificationSound';
import { showDesktopNotification } from '../utils/desktopNotification';
import { buildContractUrl } from '../utils/contractUrl';
import { queueContractDetection, tryRickEnrich } from '../discord/contractPendingQueue';
import { cacheDiscordMessage } from '../discord/messageReplyCache';

function isUserHighlighted(
  discordUserId: string,
  username: string,
  room: Room | undefined,
  globalHighlighted: string[],
): boolean {
  const handles = [
    ...globalHighlighted,
    ...(room?.highlightedUsers ?? []),
  ];
  return handles.some((h) => {
    const v = h.replace(/^@/, '').toLowerCase();
    return h === discordUserId || v === username.toLowerCase() || v === discordUserId;
  });
}

function inferChain(address: string): 'evm' | 'sol' {
  return address.startsWith('0x') ? 'evm' : 'sol';
}

async function loadHistoryFromClient(gw: GatewayManager, rooms: Room[]): Promise<void> {
  const store = useAppStore.getState();
  const channelToRooms = new Map<string, string[]>();
  for (const room of rooms) {
    for (const ch of room.channels) {
      if (ch.source && ch.source !== 'discord') continue;
      const list = channelToRooms.get(ch.channelId) ?? [];
      list.push(room.id);
      channelToRooms.set(ch.channelId, list);
    }
  }

  for (const [channelId, roomIds] of channelToRooms) {
    try {
      const raw = await gw.fetchChannelMessages(channelId, 30);
      const config = store.config;
      if (!config) continue;
      for (const msg of raw) {
        const room = rooms.find((r) => roomIds.includes(r.id));
        const frontend = processDiscordMessage(
          gw,
          msg,
          gw.getChannelName(channelId),
          msg.guild_id ? gw.getGuildName(msg.guild_id) : null,
          room?.keywordPatterns,
          {
            config,
            isHighlighted: isUserHighlighted(
              msg.author.id,
              msg.author.username,
              room,
              config.globalHighlightedUsers ?? [],
            ),
            cacheUserName: () => {},
          },
        );
        store.addMessage(frontend, roomIds);
      }
    } catch (err) {
      console.warn('[ClientGW] History fetch failed for channel', channelId, err);
    }
  }
}

function handleLiveMessage(gw: GatewayManager, rawMsg: DiscordMessage & { _channelName?: string; _guildName?: string | null }) {
  const state = useAppStore.getState();
  const cfg = state.config;
  if (!cfg) return;

  const isDM = !rawMsg.guild_id && gw.getDMChannels().some((dm) => dm.id === rawMsg.channel_id);
  const matchedRooms = state.rooms.filter((r) =>
    r.channels.some((c) => c.channelId === rawMsg.channel_id && (c.source ?? 'discord') === 'discord'),
  );
  if (matchedRooms.length === 0 && !isDM) return;

  cacheDiscordMessage(rawMsg);

  const roomIds = matchedRooms.map((r) => r.id);
  if (isDM) roomIds.push(`dm:${rawMsg.channel_id}`);

  const primaryRoom = matchedRooms[0];
  const frontend = processDiscordMessage(
    gw,
    rawMsg,
    rawMsg._channelName,
    rawMsg._guildName,
    primaryRoom?.keywordPatterns,
    {
      config: cfg,
      isHighlighted: matchedRooms.some((r) =>
        isUserHighlighted(rawMsg.author.id, rawMsg.author.username, r, cfg.globalHighlightedUsers ?? []),
      ),
      cacheUserName: () => {},
    },
  );

  state.addMessage(frontend, roomIds);

  const ss = cfg.soundSettings;
  let eventSoundPlayed = false;

  if (frontend.isHighlighted && frontend.hasContractAddress) {
    if (cfg.messageSounds) { playContractAlertSound(ss?.contractAlert); eventSoundPlayed = true; }
    if (cfg.autoOpenHighlightedContracts && frontend.contractAddresses.length > 0) {
      const addr = frontend.contractAddresses[0];
      const evmChain = state.addressChains[addr.toLowerCase()];
      window.open(buildContractUrl(addr, cfg.contractLinkTemplates, evmChain), '_blank');
    }
    if (cfg.desktopNotifications) showDesktopNotification(frontend, 'Contract from highlighted user');
  } else if (frontend.matchedKeywords?.length && cfg.keywordAlertsEnabled) {
    if (cfg.messageSounds) { playKeywordAlertSound(ss?.keywordAlert); eventSoundPlayed = true; }
    if (cfg.desktopNotifications) showDesktopNotification(frontend, `Keyword: ${frontend.matchedKeywords.join(', ')}`);
  } else if (frontend.isHighlighted) {
    if (cfg.messageSounds) { playHighlightSound(ss?.highlight); eventSoundPlayed = true; }
    if (cfg.desktopNotifications) showDesktopNotification(frontend, 'Highlighted user');
  }

  if (!eventSoundPlayed && cfg.messageSounds) {
    const chSound = cfg.channelSounds?.[frontend.channelId];
    if (chSound?.enabled) playHighlightSound(chSound);
  }

  if (frontend.hasContractAddress) {
    for (const address of frontend.contractAddresses) {
      const seenBefore = state.contracts.some(
        (c) => c.address.toLowerCase() === address.toLowerCase(),
      );
      const entry: ContractEntry = {
        address,
        chain: inferChain(address),
        authorId: frontend.author.id,
        authorName: frontend.author.displayName,
        channelId: frontend.channelId,
        channelName: frontend.channelName,
        guildId: frontend.guildId,
        guildName: frontend.guildName,
        roomIds,
        messageId: frontend.id,
        timestamp: frontend.timestamp,
        firstSeen: !seenBefore,
      };
      queueContractDetection(entry);
    }
  }
}

/** Hosted-mode Discord gateway running in the browser — token never hits the server. */
export function useClientGateway() {
  const wiredRef = useRef<GatewayManager | null>(null);
  const rooms = useAppStore((s) => s.rooms);
  const config = useAppStore((s) => s.config);
  const authConfigured = useAppStore((s) => s.authStatus?.configured);

  useEffect(() => {
    if (!isClientGatewayMode() || !isHostedMode) return;

    const tokens = getLocalDiscordTokens();
    if (tokens.length === 0) {
      disconnectClientGateway();
      wiredRef.current = null;
      useAppStore.getState().setConnected(false);
      return;
    }

    const gw = connectClientGateway(tokens);
    if (wiredRef.current === gw) return;
    wiredRef.current = gw;

    const onReady = async () => {
      console.log('[ClientGW] Ready');
      const store = useAppStore.getState();
      store.setGatewayAuthError(null);
      store.setConnected(true);
      const manager = getClientGatewayManager();
      if (!manager) return;
      useAppStore.setState({
        guilds: manager.getGuilds(),
        dmChannels: manager.getDMChannels(),
        authStatus: {
          ...store.authStatus,
          configured: true,
          connected: true,
          clientGateway: true,
        },
      });
      await loadHistoryFromClient(manager, useAppStore.getState().rooms);
    };

    const onMessage = (rawMsg: DiscordMessage & { _channelName?: string; _guildName?: string | null }) => {
      handleLiveMessage(gw, rawMsg);
      void tryRickEnrich(rawMsg);
    };

    const onMessageUpdate = (msg: Partial<DiscordMessage> & { id: string; channel_id: string }) => {
      useAppStore.getState().updateMessage({
        messageId: msg.id,
        channelId: msg.channel_id,
        content: msg.content,
        embeds: msg.embeds as FrontendMessage['embeds'],
        attachments: msg.attachments as FrontendMessage['attachments'],
        editedTimestamp: msg.edited_timestamp ?? null,
      });
      void tryRickEnrich(msg);
    };

    const onMessageDelete = (data: { id: string; channel_id: string }) => {
      useAppStore.getState().markMessageDeleted({ messageId: data.id, channelId: data.channel_id });
    };

    const onReactionUpdate = (data: { channelId: string; messageId: string; emoji: FrontendReaction['emoji']; delta: number }) => {
      useAppStore.getState().updateReaction(data.channelId, data.messageId, data.emoji, data.delta);
    };

    const onAuthFailed = (failure: { message: string; blocked?: boolean }) => {
      useAppStore.getState().setGatewayAuthError(failure.message, failure.blocked);
      useAppStore.getState().setConnected(false);
      useAppStore.getState().fetchMaskedTokens();
    };

    gw.on('ready', onReady);
    gw.on('message', onMessage);
    gw.on('messageUpdate', onMessageUpdate);
    gw.on('messageDelete', onMessageDelete);
    gw.on('reactionUpdate', onReactionUpdate);
    gw.on('auth_failed', onAuthFailed);

    return () => {
      gw.off('ready', onReady);
      gw.off('message', onMessage);
      gw.off('messageUpdate', onMessageUpdate);
      gw.off('messageDelete', onMessageDelete);
      gw.off('reactionUpdate', onReactionUpdate);
      gw.off('auth_failed', onAuthFailed);
    };
  }, [authConfigured, config, rooms]);

  useEffect(() => {
    if (!isClientGatewayMode()) return;
    const tokens = getLocalDiscordTokens();
    if (tokens.length > 0 && !getClientGatewayManager()) {
      connectClientGateway(tokens);
    }
  }, [authConfigured]);
}
