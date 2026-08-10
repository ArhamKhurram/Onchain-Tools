import { useEffect, useRef } from 'react';
import { useAppStore, IS_POPOUT } from '../stores/appStore';
import { playHighlightSound, playContractAlertSound, playKeywordAlertSound, playFomoTradeSound, playPumpCalloutSound, playSound } from '../utils/notificationSound';
import { buildContractUrl, buildRevivalContractUrl, revivalNetworkLabel } from '../utils/contractUrl';
import { showDesktopNotification } from '../utils/desktopNotification';
import { fomoTradeDisplay, buildFomoTradeAlertMessage } from '../utils/fomoTradeDisplay';
import { formatMcap } from '../types/pumpfun';
import { isDemoMode } from '../demo/demoStore';
import { isHostedMode, getSupabase } from '../lib/supabase';
import { isClientGatewayMode } from '../discord/clientGateway';
import { hasLocalDiscordTokens } from '../discord/tokenStore';
import { buildStreamMessage, STREAM_POOL } from '../demo/demoData';
import type { WsIncoming, Alert, FrontendMessage, ContractEntry, RevivalAlertData } from '../types';
import type { FomoTradeEvent } from '../types/fomo';

let idCounter = 0;

function useDemoStream() {
  const addMessage = useAppStore((s) => s.addMessage);
  const setConnected = useAppStore((s) => s.setConnected);
  const poolIndex = useRef(0);

  useEffect(() => {
    if (!isDemoMode) return;
    setConnected(true);

    const interval = setInterval(() => {
      const { message, roomIds } = buildStreamMessage(poolIndex.current);
      poolIndex.current = (poolIndex.current + 1) % STREAM_POOL.length;
      addMessage(message, roomIds);
    }, 6000 + Math.random() * 4000);

    return () => clearInterval(interval);
  }, [addMessage, setConnected]);
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const addMessage = useAppStore((s) => s.addMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const markMessageDeleted = useAppStore((s) => s.markMessageDeleted);
  const addAlert = useAppStore((s) => s.addAlert);
  const setConnected = useAppStore((s) => s.setConnected);
  const updateReaction = useAppStore((s) => s.updateReaction);
  const addContract = useAppStore((s) => s.addContract);
  const enrichContract = useAppStore((s) => s.enrichContract);
  const updateContractChain = useAppStore((s) => s.updateContractChain);
  const fetchGuilds = useAppStore((s) => s.fetchGuilds);
  const fetchDMChannels = useAppStore((s) => s.fetchDMChannels);
  const fetchHistory = useAppStore((s) => s.fetchHistory);
  const fetchTelegramChats = useAppStore((s) => s.fetchTelegramChats);
  const checkAuth = useAppStore((s) => s.checkAuth);
  const setGatewayAuthError = useAppStore((s) => s.setGatewayAuthError);
  const fetchMaskedTokens = useAppStore((s) => s.fetchMaskedTokens);
  const addFomoTrade = useAppStore((s) => s.addFomoTrade);
  const addRevival = useAppStore((s) => s.addRevival);

  useDemoStream();

  useEffect(() => {
    if (isDemoMode) return;

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    let wsUrl: string;
    if (import.meta.env.VITE_API_URL) {
      const apiUrl = new URL(import.meta.env.VITE_API_URL);
      const wsProtocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${wsProtocol}//${apiUrl.host}/ws`;
    } else {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    }

    function connect() {
      if (disposed) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        if (disposed) { ws.close(); return; }
        console.log('[WS] Connected');
        if (!(isClientGatewayMode() && hasLocalDiscordTokens())) {
          setConnected(true);
        }

        if (isHostedMode) {
          try {
            const { data } = await getSupabase().auth.getSession();
            if (data.session?.access_token) {
              ws.send(JSON.stringify({ type: 'auth', token: data.session.access_token }));
            }
          } catch {}
        }

        ws.send(JSON.stringify({ type: 'subscribe_all' }));
      };

      ws.onmessage = (event) => {
        try {
          const incoming: WsIncoming = JSON.parse(event.data);
          const skipDiscordWs = isClientGatewayMode() && hasLocalDiscordTokens();

          if (incoming.type === 'message') {
            const msg = incoming.data as FrontendMessage;
            if (skipDiscordWs && msg.source !== 'telegram') return;
            const roomIds = incoming.roomIds ?? [];
            const config = useAppStore.getState().config;

            // Popout windows share the main window's live stream but must not
            // duplicate sounds, notifications, or contract auto-open.
            if (IS_POPOUT) {
              addMessage(msg, roomIds, true);
              return;
            }

            const ss = config?.soundSettings;

            let eventSoundPlayed = false;

            if (msg.isHighlighted && msg.hasContractAddress) {
              if (config?.messageSounds) { playContractAlertSound(ss?.contractAlert); eventSoundPlayed = true; }
              if (config?.autoOpenHighlightedContracts && msg.contractAddresses.length > 0) {
                const addr = msg.contractAddresses[0];
                const evmChain = useAppStore.getState().addressChains[addr.toLowerCase()];
                const url = buildContractUrl(
                  addr,
                  config.contractLinkTemplates,
                  evmChain,
                );
                window.open(url, '_blank');
              }
              if (config?.desktopNotifications) {
                showDesktopNotification(msg, 'Contract from highlighted user');
              }
            } else if (msg.matchedKeywords && msg.matchedKeywords.length > 0 && config?.keywordAlertsEnabled) {
              if (config?.messageSounds) { playKeywordAlertSound(ss?.keywordAlert); eventSoundPlayed = true; }
              if (config?.desktopNotifications) {
                showDesktopNotification(msg, `Keyword: ${msg.matchedKeywords.join(', ')}`);
              }
            } else if (msg.isHighlighted) {
              if (config?.messageSounds) { playHighlightSound(ss?.highlight); eventSoundPlayed = true; }
              if (config?.desktopNotifications) {
                showDesktopNotification(msg, 'Highlighted user');
              }
            }

            if (!eventSoundPlayed && config?.messageSounds) {
              const chSound = config.channelSounds?.[msg.channelId];
              if (chSound?.enabled) {
                playSound('highlight', chSound);
              }
            }

            addMessage(msg, roomIds, true);
          } else if (incoming.type === 'alert') {
            const alertData = incoming.data as { type: string; message: FrontendMessage; reason: string };
            const alert: Alert = {
              id: `alert-${++idCounter}`,
              type: alertData.type as Alert['type'],
              message: alertData.message,
              reason: alertData.reason,
              timestamp: Date.now(),
            };
            // Suppressed as a duplicate contract scan → no toast, no sound.
            if (!addAlert(alert)) return;

            if (!IS_POPOUT) {
              const cfg = useAppStore.getState().config;
              const ss = cfg?.soundSettings;
              if (cfg?.messageSounds) {
                if (alert.type === 'contract_address') {
                  playContractAlertSound(ss?.contractAlert);
                } else if (alert.type === 'highlighted_user') {
                  if (alert.message.hasContractAddress) playContractAlertSound(ss?.contractAlert);
                  else playHighlightSound(ss?.highlight);
                } else if (alert.type === 'keyword_match') {
                  playKeywordAlertSound(ss?.keywordAlert);
                } else if (alert.type === 'missed_runner') {
                  playContractAlertSound(ss?.contractAlert);
                }
              }
            }
          } else if (incoming.type === 'message_update') {
            if (skipDiscordWs) return;
            updateMessage(incoming.data);
          } else if (incoming.type === 'message_delete') {
            if (skipDiscordWs) return;
            markMessageDeleted(incoming.data);
          } else if (incoming.type === 'reaction_update') {
            if (skipDiscordWs) return;
            const { channelId, messageId, emoji, delta } = incoming.data;
            updateReaction(channelId, messageId, emoji, delta);
          } else if (incoming.type === 'contract') {
            // Not gated on skipDiscordWs: this is the backend confirming a
            // scan was logged (Telegram is always detected server-side; a
            // browser-gateway Discord scan echoes back the same POST) — not
            // a raw Discord message, so it's authoritative either way.
            // addContract() dedupes by messageId+address, so this is a
            // no-op for scans the browser gateway already added locally.
            const entry = incoming.data as ContractEntry;
            addContract(entry);
          } else if (incoming.type === 'contract_enrichment') {
            const entry = incoming.data as ContractEntry;
            enrichContract(entry);
          } else if (incoming.type === 'chain_update') {
            const { address, evmChain } = incoming.data as { address: string; evmChain: string };
            updateContractChain(address, evmChain);
          } else if (incoming.type === 'gateway_ready') {
            if (!skipDiscordWs) {
              fetchGuilds();
              fetchDMChannels();
              fetchHistory();
            }
          } else if (incoming.type === 'telegram_ready') {
            fetchTelegramChats();
            fetchHistory();
            checkAuth();
          } else if (incoming.type === 'fomo_trade') {
            // `notify` is a delivery-time flag, not part of the trade itself
            // (backfilled/replayed trades never carry it) — strip it before
            // storing so it never leaks into the feed's persisted shape.
            const { notify, ...tradeData } = incoming.data as FomoTradeEvent & { notify?: boolean };
            addFomoTrade(tradeData);

            if (notify && !IS_POPOUT) {
              const cfg = useAppStore.getState().config;
              const display = fomoTradeDisplay(tradeData, cfg?.contractLinkTemplates);
              const alert: Alert = {
                id: `fomo-trade-alert-${++idCounter}`,
                type: 'fomo_trade',
                message: buildFomoTradeAlertMessage(tradeData, display),
                reason: `${tradeData.displayName || (tradeData.fomoHandle ? `@${tradeData.fomoHandle}` : 'Tracked trader')} ${tradeData.side === 'sell' ? 'sold' : 'bought'} ${display.tokenLabel}`,
                timestamp: Date.now(),
              };
              addAlert(alert);
              if (cfg?.messageSounds) playFomoTradeSound(cfg.soundSettings?.fomoTrade);
            }
          } else if (incoming.type === 'pump_callout') {
            // A followed pump.fun caller posted a callout. `notify` gates the
            // toast/sound the same way it does for FOMO; the ping always lands
            // in notification history via addAlert.
            const d = incoming.data as {
              calloutId: string;
              callerAddress: string;
              username: string | null;
              avatar: string | null;
              coinMint: string;
              symbol: string | null;
              marketCapUsd: number | null;
              thesis: string | null;
              notify?: boolean;
            };
            if (!IS_POPOUT) {
              const who = d.username ? `@${d.username}` : 'A tracked caller';
              const coin = d.symbol ? `$${d.symbol}` : d.coinMint ? `${d.coinMint.slice(0, 4)}…pump` : 'a coin';
              const mc = typeof d.marketCapUsd === 'number' ? ` · MC ${formatMcap(d.marketCapUsd)}` : '';
              const alert: Alert = {
                id: `pump-callout-${d.calloutId}`,
                type: 'pump_callout',
                reason: `${who} called ${coin}`,
                message: {
                  id: `pump-callout-${d.calloutId}`,
                  channelId: 'pump-callout',
                  guildId: null,
                  channelName: 'PUMP',
                  guildName: null,
                  author: { id: 'oct-pump', username: 'OCT', displayName: 'Pump Callout', avatar: d.avatar ?? null },
                  content: `${d.thesis ? `${d.thesis} · ` : ''}${coin}${mc}`,
                  timestamp: new Date().toISOString(),
                  attachments: [],
                  embeds: [],
                  isHighlighted: false,
                  hasContractAddress: !!d.coinMint,
                  contractAddresses: d.coinMint ? [d.coinMint] : [],
                  mentions: {},
                  platformUrl: d.coinMint ? `https://pump.fun/coin/${d.coinMint}` : undefined,
                },
                timestamp: Date.now(),
              };
              addAlert(alert);
              const cfg = useAppStore.getState().config;
              if (cfg?.messageSounds) playPumpCalloutSound(cfg.soundSettings?.pumpCallout);
            }
          } else if (incoming.type === 'revival_alert') {
            // A dormant token on the user's radar just ignited — the loudest
            // alert class in the app. The banner (with its repeating sound
            // loop) persists until explicitly dismissed; the ping also lands
            // in notification history via addAlert. Revival is its own signal:
            // never fused with convergence / missed-runner / FOMO.
            const d = incoming.data as RevivalAlertData;
            if (!IS_POPOUT) {
              addRevival(d);

              const cfg = useAppStore.getState().config;
              const sym = d.symbol ? `$${d.symbol}` : `${d.mint.slice(0, 6)}…`;
              const mc = typeof d.mcapUsd === 'number' ? formatMcap(d.mcapUsd) : '—';
              const chain = revivalNetworkLabel(d.network);
              // The alert's own chain decides the link — a Robinhood revival
              // opened on the EVM template's default chain is a dead page.
              const url = cfg
                ? buildRevivalContractUrl(d.mint, d.network, cfg.contractLinkTemplates)
                : undefined;
              const alert: Alert = {
                id: `revival-${d.mint}-${d.triggeredAt}`,
                type: 'revival',
                reason: `REVIVAL: ${sym} igniting on ${chain}`,
                message: {
                  id: `revival-${d.mint}-${d.triggeredAt}`,
                  channelId: 'revival',
                  guildId: null,
                  channelName: 'REVIVAL',
                  guildName: null,
                  author: { id: 'oct-revival', username: 'OCT', displayName: 'Revival', avatar: null },
                  content: `${sym} igniting on ${chain} — mcap ${mc}, RVOL ${d.rvol.toFixed(1)}x, ATR z ${d.atrZ.toFixed(1)}`,
                  timestamp: d.triggeredAt,
                  attachments: [],
                  embeds: [],
                  isHighlighted: false,
                  hasContractAddress: true,
                  contractAddresses: [d.mint],
                  mentions: {},
                  platformUrl: url,
                },
                timestamp: Date.now(),
              };
              addAlert(alert);
            }
          } else if (incoming.type === 'wallet_movement') {
            // A tracked Directory (user_tracked_wallets) SOLANA wallet made an
            // on-chain buy/sell. `notify` gates the toast/sound (mirrors FOMO);
            // the ping always lands in notification history via addAlert.
            const d = incoming.data as {
              txHash: string;
              walletAddress: string;
              side: 'buy' | 'sell' | null;
              tokenMint: string | null;
              tokenSymbol: string | null;
              amount: number | null;
              solValue: number | null;
              name: string;
              emoji: string;
              alertsOnToast: boolean;
              notify?: boolean;
            };
            if (!IS_POPOUT) {
              const who = d.name
                ? `${d.emoji ? `${d.emoji} ` : ''}${d.name}`
                : `${d.walletAddress.slice(0, 4)}…${d.walletAddress.slice(-4)}`;
              const verb = d.side === 'sell' ? 'sold' : d.side === 'buy' ? 'bought' : 'traded';
              const coin = d.tokenSymbol
                ? `$${d.tokenSymbol}`
                : d.tokenMint
                  ? `${d.tokenMint.slice(0, 4)}…`
                  : 'a token';
              const sol = typeof d.solValue === 'number' ? ` · ${d.solValue.toFixed(2)} SOL` : '';
              const alert: Alert = {
                id: `wallet-movement-${d.txHash}`,
                type: 'wallet_movement',
                reason: `${who} ${verb} ${coin}`,
                message: {
                  id: `wallet-movement-${d.txHash}`,
                  channelId: 'wallet-movement',
                  guildId: null,
                  channelName: 'WALLET',
                  guildName: null,
                  author: { id: 'oct-wallet', username: 'OCT', displayName: 'Wallet Movement', avatar: null },
                  content: `${who} ${verb} ${coin}${sol}`,
                  timestamp: new Date().toISOString(),
                  attachments: [],
                  embeds: [],
                  isHighlighted: false,
                  hasContractAddress: !!d.tokenMint,
                  contractAddresses: d.tokenMint ? [d.tokenMint] : [],
                  mentions: {},
                  platformUrl: d.tokenMint ? `https://pump.fun/coin/${d.tokenMint}` : undefined,
                },
                timestamp: Date.now(),
              };
              addAlert(alert);
              if (d.notify) {
                const cfg = useAppStore.getState().config;
                if (cfg?.messageSounds) playFomoTradeSound(cfg.soundSettings?.fomoTrade);
              }
            }
          } else if (incoming.type === 'gateway_auth_failed') {
            if (!skipDiscordWs) {
              setGatewayAuthError(
                incoming.error ?? 'Discord token authentication failed. Please check your token in settings.',
                incoming.tokenBlocked,
              );
              fetchMaskedTokens();
            }
          }
        } catch {
          // ignore malformed
        }
      };

      ws.onclose = () => {
        if (!(isClientGatewayMode() && hasLocalDiscordTokens())) {
          setConnected(false);
        }
        if (disposed) return;
        console.log('[WS] Disconnected, reconnecting in 3s...');
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [addMessage, updateMessage, markMessageDeleted, addAlert, setConnected, updateReaction, addContract, enrichContract, updateContractChain, fetchGuilds, fetchDMChannels, fetchHistory, fetchTelegramChats, checkAuth, setGatewayAuthError, fetchMaskedTokens, addFomoTrade, addRevival]);
}
