/**
 * Manual missed-runner test for a single token (settings UI).
 * Skips cooldown; optional force bypasses multiplier threshold. Never writes dedupe rows.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getFomoServiceClient } from '../fomo/store.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import { fetchLiveMarketCap } from '../utils/tokenEnrichment.js';
import { buildContractUrl } from '../utils/contract.js';
import { checkTokenHeldByWallets, formatCompact, type TrackedWalletRow } from '../wallets/balanceChecker.js';
import type { ContractEntry } from '../utils/contractLog.js';
import type { AppConfig, FrontendMessage } from '../discord/types.js';
import type { WsServer } from '../ws/server.js';
import {
  buildMissedRunnerMessage,
  buildTokenCandidates,
  resolveMissedRunnerConfig,
  resolveNotifyVia,
  canSendPushover,
  formatMissedRunnerAge,
  type TokenCandidate,
} from './missedRunnerPoller.js';

export interface MissedRunnerTestDiagnostics {
  foundInFeed: boolean;
  mcAtCall?: number;
  mcAtCallDisplay?: string;
  mcNow?: number;
  mcNowDisplay?: string;
  multiplier?: number;
  minMultiplier: number;
  multiplierMet: boolean;
  holds?: boolean;
  balanceSkipped?: boolean;
  balanceReason?: string;
  onCooldown: boolean;
  wouldAlert: boolean;
  blockReason?: string;
}

export interface MissedRunnerTestResult {
  ok: boolean;
  sent: boolean;
  message: string;
  diagnostics: MissedRunnerTestDiagnostics;
}

async function loadHoldingWallets(db: SupabaseClient | null, userId: string): Promise<TrackedWalletRow[]> {
  if (!db) return [];
  const { data, error } = await db
    .from('user_holding_wallets')
    .select('id, address, chain')
    .eq('user_id', userId);
  if (error) return [];
  return (data ?? []) as TrackedWalletRow[];
}

async function isOnCooldown(db: SupabaseClient | null, userId: string, tokenAddress: string): Promise<boolean> {
  if (!db) return false;
  const { data, error } = await db
    .from('missed_runner_alerts')
    .select('cooldown_until')
    .eq('user_id', userId)
    .ilike('token_address', tokenAddress)
    .maybeSingle();
  if (error || !data) return false;
  return new Date(data.cooldown_until).getTime() > Date.now();
}

function findTokenCandidate(contracts: ContractEntry[], address: string): TokenCandidate | null {
  const needle = address.trim().toLowerCase();
  const matching = contracts.filter((c) => c.address.toLowerCase() === needle);
  if (matching.length === 0) return null;
  const candidates = buildTokenCandidates(matching);
  return candidates[0] ?? null;
}

function dispatchMissedRunnerAlert(
  wsServer: WsServer,
  userId: string,
  config: AppConfig,
  token: TokenCandidate,
  body: string,
  title: string,
  testPrefix: boolean,
): { toast: boolean; pushover: boolean } {
  const via = resolveNotifyVia(config, resolveMissedRunnerConfig(config));
  const sendToast = via === 'toast' || via === 'both';
  const sendPush = (via === 'pushover' || via === 'both') && canSendPushover(config);
  const prefix = testPrefix ? 'TEST · ' : '';
  const fullTitle = `${prefix}${title}`;
  const fullBody = testPrefix ? `[Test alert — not recorded]\n${body}` : body;

  const url = buildContractUrl(
    token.address,
    config.contractLinkTemplates,
    token.evmChain ?? undefined,
  );

  if (sendToast) {
    wsServer.broadcastAlert({
      type: 'missed_runner',
      reason: fullTitle,
      message: buildMissedRunnerMessage(token, fullBody, url),
    }, userId);
  }

  if (sendPush) {
    void sendPushover(config.pushover, {
      title: fullTitle,
      message: fullBody,
      url,
      urlTitle: 'Open token',
    });
  }

  return { toast: sendToast, pushover: sendPush };
}

export async function testMissedRunnerForAddress(
  wsServer: WsServer,
  userId: string,
  rawAddress: string,
  options: { force?: boolean } = {},
): Promise<MissedRunnerTestResult> {
  const address = rawAddress.trim();
  if (!address) {
    return {
      ok: false,
      sent: false,
      message: 'Enter a contract address.',
      diagnostics: {
        foundInFeed: false,
        minMultiplier: 1.5,
        multiplierMet: false,
        onCooldown: false,
        wouldAlert: false,
        blockReason: 'missing_address',
      },
    };
  }

  const storage = getStorageProvider();
  const config = await storage.getConfig(userId);
  const mr = resolveMissedRunnerConfig(config);
  const db = getFomoServiceClient();

  const since = new Date(Date.now() - mr.lookbackHours * 3_600_000).toISOString();
  const contracts = await storage.getContracts(userId, 500, since);
  const token = findTokenCandidate(contracts, address);

  const diagnostics: MissedRunnerTestDiagnostics = {
    foundInFeed: !!token,
    minMultiplier: mr.minMultiplier,
    multiplierMet: false,
    onCooldown: false,
    wouldAlert: false,
  };

  if (!token) {
    return {
      ok: false,
      sent: false,
      message: `No scan with MC@call found for this address in the last ${mr.lookbackHours}h. Check the contract feed or lookback window.`,
      diagnostics: { ...diagnostics, blockReason: 'not_in_feed_or_no_mc' },
    };
  }

  diagnostics.mcAtCall = token.mcAtCall;
  diagnostics.mcAtCallDisplay = token.mcAtCallDisplay;
  diagnostics.onCooldown = await isOnCooldown(db, userId, token.address);

  if (mr.minMcAtCall != null && token.mcAtCall < mr.minMcAtCall) {
    return {
      ok: false,
      sent: false,
      message: `MC@call ${token.mcAtCallDisplay ?? formatCompact(token.mcAtCall)} is below your min MC@call filter.`,
      diagnostics: { ...diagnostics, blockReason: 'min_mc_at_call' },
    };
  }

  const live = await fetchLiveMarketCap(token.address, token.evmChain ?? undefined);
  if (!live?.mcNow || live.mcNow <= 0) {
    return {
      ok: false,
      sent: false,
      message: 'Could not fetch live MC (try again or check GMGN/DexScreener for this chain).',
      diagnostics: { ...diagnostics, blockReason: 'no_live_mc' },
    };
  }

  diagnostics.mcNow = live.mcNow;
  diagnostics.mcNowDisplay = live.mcNowDisplay;
  const multiplier = live.mcNow / token.mcAtCall;
  diagnostics.multiplier = multiplier;
  diagnostics.multiplierMet = multiplier >= mr.minMultiplier;

  const wallets = await loadHoldingWallets(db, userId);
  const balance = await checkTokenHeldByWallets(
    token.address,
    token.chain,
    token.evmChain,
    wallets,
  );
  diagnostics.holds = balance.holds;
  diagnostics.balanceSkipped = balance.skipped;
  diagnostics.balanceReason = balance.reason;

  if (balance.skipped) {
    return {
      ok: false,
      sent: false,
      message: `Balance check skipped: ${balance.reason ?? 'unknown'}.`,
      diagnostics: { ...diagnostics, blockReason: 'balance_skipped' },
    };
  }

  if (balance.holds) {
    return {
      ok: false,
      sent: false,
      message: 'You hold this token in My Wallets — missed-runner would not fire.',
      diagnostics: { ...diagnostics, blockReason: 'holds_token' },
    };
  }

  const cooldownBlocks = diagnostics.onCooldown && !options.force;
  const multiplierBlocks = !diagnostics.multiplierMet && !options.force;

  diagnostics.wouldAlert = !cooldownBlocks && !multiplierBlocks;

  const symbol = token.tokenSymbol ? `$${token.tokenSymbol}` : token.address.slice(0, 8);
  const multLabel = `${multiplier.toFixed(1)}×`;
  const mcFrom = token.mcAtCallDisplay ?? formatCompact(token.mcAtCall);
  const mcTo = live.mcNowDisplay ?? formatCompact(live.mcNow);
  const age = formatMissedRunnerAge(token.firstSeenAt);
  const channel = token.channelName ? `#${token.channelName}` : 'your feed';
  const title = `Missed runner: ${symbol} (${multLabel})`;
  const body = `Scanned ${age} ago in ${channel} · MC ${mcFrom} → ${mcTo} · Not in My Wallets`;

  if (!diagnostics.wouldAlert && !options.force) {
    const parts: string[] = [];
    if (multiplierBlocks) {
      parts.push(`multiplier ${multLabel} below threshold ${mr.minMultiplier.toFixed(2)}×`);
    }
    if (cooldownBlocks) parts.push('token is on alert cooldown');
    return {
      ok: true,
      sent: false,
      message: `Would not alert: ${parts.join('; ')}. Enable "Force send" to preview anyway.`,
      diagnostics: { ...diagnostics, blockReason: parts.join('; ') },
    };
  }

  const via = resolveNotifyVia(config, mr);
  if (via === 'pushover' && !canSendPushover(config)) {
    return {
      ok: false,
      sent: false,
      message: 'Pushover is selected but not configured.',
      diagnostics: { ...diagnostics, blockReason: 'pushover_not_configured' },
    };
  }

  const channels = dispatchMissedRunnerAlert(wsServer, userId, config, token, body, title, true);
  if (!channels.toast && !channels.pushover) {
    return {
      ok: false,
      sent: false,
      message: 'No delivery channel enabled (check Deliver via).',
      diagnostics: { ...diagnostics, blockReason: 'no_delivery_channel' },
    };
  }

  const viaLabel = channels.toast && channels.pushover ? 'toast and Pushover'
    : channels.toast ? 'toast' : 'Pushover';

  return {
    ok: true,
    sent: true,
    message: options.force && !diagnostics.wouldAlert
      ? `Forced test alert sent via ${viaLabel}.`
      : `Test alert sent via ${viaLabel} (production rules passed).`,
    diagnostics,
  };
}
