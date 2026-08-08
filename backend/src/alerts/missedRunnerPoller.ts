/**
 * Missed-runner alert poller.
 *
 * Every few minutes, for each user with missedRunner enabled:
 * 1. Load recent contracts with MC@call
 * 2. Dedupe by token; keep earliest scan MC
 * 3. Fetch live MC via GMGN (then DexScreener fallback) — separate from Portfolio (Birdeye)
 * 4. If multiplier threshold met and user doesn't hold token → toast / Pushover / both
 * 5. Record dedupe row in missed_runner_alerts
 *
 * Self-gates on Supabase (hosted mode). Idle in local/json mode without Supabase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getFomoServiceClient } from '../fomo/store.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import { fetchLiveMarketCap } from '../utils/tokenEnrichment.js';
import { recordPeakObservation } from './tokenPeakStore.js';
import { buildContractUrl } from '../utils/contract.js';
import { checkTokenHeldByWallets, formatCompact, type TrackedWalletRow } from '../wallets/balanceChecker.js';
import type { ContractEntry } from '../utils/contractLog.js';
import type { AppConfig, FrontendMessage, MissedRunnerConfig, MissedRunnerNotifyVia } from '../discord/types.js';
import type { WsServer } from '../ws/server.js';

const DEFAULT_INTERVAL_MS = 180_000; // 3 min
// An FDV represents the group's MC@call only if captured within this of the
// first mention — the same call event, not a re-mention hours later.
const MC_AT_CALL_MAX_LAG_MS = 900_000; // 15 min

const DEFAULT_MISSED_RUNNER: MissedRunnerConfig = {
  enabled: false,
  minMultiplier: 1.5,
  lookbackHours: 24,
  cooldownHours: 24,
  notifyVia: 'toast',
};

export interface TokenCandidate {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
  mcAtCall: number;
  mcAtCallDisplay?: string;
  tokenSymbol?: string;
  tokenName?: string;
  channelName?: string;
  firstSeenAt: string;
}

export function resolveMissedRunnerConfig(config: AppConfig): MissedRunnerConfig {
  return { ...DEFAULT_MISSED_RUNNER, ...config.missedRunner };
}

export function resolveNotifyVia(config: AppConfig, mr: MissedRunnerConfig): MissedRunnerNotifyVia {
  if (mr.notifyVia) return mr.notifyVia;
  if (config.pushover?.enabled && (config.pushover.triggers?.missedRunner ?? false)) return 'pushover';
  return 'toast';
}

export function canSendPushover(config: AppConfig): boolean {
  const p = config.pushover;
  return !!(p?.enabled && p.appToken?.trim() && p.userKey?.trim());
}

function shouldPollUser(settings: Partial<AppConfig>): boolean {
  const mr = { ...DEFAULT_MISSED_RUNNER, ...settings.missedRunner };
  if (!mr.enabled) return false;
  const via = resolveNotifyVia(settings as AppConfig, mr);
  if (via === 'toast') return true;
  if (via === 'pushover') return canSendPushover(settings as AppConfig);
  return true;
}

export function buildMissedRunnerMessage(
  token: TokenCandidate,
  body: string,
  url: string,
): FrontendMessage {
  return {
    id: `missed-runner-${token.address}-${Date.now()}`,
    channelId: 'missed-runner',
    guildId: null,
    channelName: token.channelName ?? 'Missed runner',
    guildName: null,
    author: {
      id: 'oct-missed-runner',
      username: 'OCT',
      displayName: 'Missed Runner',
      avatar: null,
    },
    content: body,
    timestamp: new Date().toISOString(),
    attachments: [],
    embeds: [],
    isHighlighted: false,
    hasContractAddress: true,
    contractAddresses: [token.address],
    mentions: {},
    platformUrl: url,
  };
}

/** Earliest scan time + first available MC@call (Rick often omits FDV on the first row). */
function resolveMcAtCall(group: ContractEntry[]): {
  mcAtCall: number;
  mcAtCallDisplay?: string;
  firstSeenAt: string;
} | null {
  const sorted = [...group].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  // MC@call is the first call's market cap. Take the earliest row with an FDV,
  // but only if captured close to first-seen — otherwise a repeat mention hours
  // later (which now gets its own FDV) would stamp its live MC onto the original
  // call, turning an honest blank into a wrong multiplier. Missing beats wrong.
  const firstMs = new Date(sorted[0].timestamp).getTime();
  const withMc = sorted.find(
    (c) =>
      c.fdvAtCall != null &&
      c.fdvAtCall > 0 &&
      new Date(c.timestamp).getTime() - firstMs <= MC_AT_CALL_MAX_LAG_MS,
  );
  if (!withMc?.fdvAtCall) return null;
  return {
    mcAtCall: withMc.fdvAtCall,
    mcAtCallDisplay: withMc.fdvAtCallDisplay,
    firstSeenAt: sorted[0].timestamp,
  };
}

/** Same MC@call logic as Radar buildRadar. */
export function buildTokenCandidates(contracts: ContractEntry[]): TokenCandidate[] {
  const byAddress = new Map<string, ContractEntry[]>();
  for (const c of contracts) {
    const key = c.address.toLowerCase();
    const list = byAddress.get(key) ?? [];
    list.push(c);
    byAddress.set(key, list);
  }

  const out: TokenCandidate[] = [];
  for (const [, group] of byAddress) {
    const resolved = resolveMcAtCall(group);
    if (!resolved) continue;
    const meta = group.find((c) => c.fdvAtCall === resolved.mcAtCall) ?? group[0];
    out.push({
      address: meta.address,
      chain: meta.chain,
      evmChain: meta.evmChain,
      mcAtCall: resolved.mcAtCall,
      mcAtCallDisplay: resolved.mcAtCallDisplay,
      tokenSymbol: meta.tokenSymbol,
      tokenName: meta.tokenName,
      channelName: meta.channelName,
      firstSeenAt: resolved.firstSeenAt,
    });
  }
  return out;
}

/**
 * Row for the missed_runner_alerts upsert. token_address must be lowercased —
 * the table's unique key (user_id, token_address) and its lowercase CHECK
 * constraint both assume it (migration 20260729130000).
 */
export function buildMissedRunnerAlertRow(
  userId: string,
  token: TokenCandidate,
  mcNow: number,
  multiplier: number,
  cooldownHours: number,
  now: number = Date.now(),
): {
  user_id: string;
  token_address: string;
  triggered_at: string;
  cooldown_until: string;
  mc_at_call: number;
  mc_now: number;
  multiplier: number;
  channel_name: string | null;
  token_symbol: string | null;
} {
  return {
    user_id: userId,
    token_address: token.address.toLowerCase(),
    triggered_at: new Date(now).toISOString(),
    cooldown_until: new Date(now + cooldownHours * 3_600_000).toISOString(),
    mc_at_call: token.mcAtCall,
    mc_now: mcNow,
    multiplier,
    channel_name: token.channelName ?? null,
    token_symbol: token.tokenSymbol ?? null,
  };
}

export function formatMissedRunnerAge(firstSeenAt: string): string {
  const mins = Math.floor((Date.now() - new Date(firstSeenAt).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

class MissedRunnerPoller {
  private wsServer: WsServer;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private started = false;

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const db = getFomoServiceClient();
    if (!db) {
      console.log('[MissedRunnerPoller] Supabase not configured; poller idle.');
      return;
    }
    this.db = db;

    const interval = Number.parseInt(process.env.MISSED_RUNNER_POLL_INTERVAL_MS ?? '', 10) || DEFAULT_INTERVAL_MS;
    console.log(`[MissedRunnerPoller] Started (interval ${interval}ms).`);
    void this.poll().catch((err) => console.error('[MissedRunnerPoller] initial poll error:', (err as Error)?.message));
    this.timer = setInterval(() => {
      void this.poll().catch((err) => console.error('[MissedRunnerPoller] poll error:', (err as Error)?.message));
    }, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // The active-user scan used to pull EVERY user's full settings JSONB every
  // sweep (3 min) just to read two subtrees — the single largest source of
  // Supabase egress in prod (each blob is tens of KB; ~480 sweeps/day).
  // Now: select only the two subtrees shouldPollUser inspects, and cache the
  // resulting id list. Cost: a newly-enabled user waits at most one TTL for
  // their first sweep — the in-app test route is unaffected.
  private activeIdsCache: { ids: string[]; at: number } | null = null;

  private async loadActiveUserIds(): Promise<string[]> {
    if (!this.db) return [];
    const ttl = Number.parseInt(process.env.MISSED_RUNNER_USERSCAN_TTL_MS ?? '', 10) || 900_000;
    if (this.activeIdsCache && Date.now() - this.activeIdsCache.at < ttl) {
      return this.activeIdsCache.ids;
    }
    const { data, error } = await this.db
      .from('user_configs')
      .select('user_id, missed_runner:settings->missedRunner, pushover:settings->pushover');
    if (error) {
      console.warn('[MissedRunnerPoller] Failed to load user configs:', error.message);
      return this.activeIdsCache?.ids ?? [];
    }
    const ids = (data ?? [])
      .filter((row: any) =>
        shouldPollUser({
          missedRunner: row.missed_runner ?? undefined,
          pushover: row.pushover ?? undefined,
        } as Partial<AppConfig>),
      )
      .map((row: any) => row.user_id as string);
    this.activeIdsCache = { ids, at: Date.now() };
    return ids;
  }

  // Column-scoped contract read for the candidate scan. getContracts()'s
  // select('*') drags the message text and every enrichment column across the
  // wire for up to 500 rows per user per sweep; the candidate builder only
  // needs these nine fields (buildTokenCandidates + resolveMcAtCall).
  private async loadContractsSlim(userId: string, since: string): Promise<ContractEntry[]> {
    if (!this.db) {
      return getStorageProvider().getContracts(userId, 500, since);
    }
    const { data, error } = await this.db
      .from('contracts')
      .select('address, chain, evm_chain, timestamp, fdv_at_call, fdv_at_call_display, token_symbol, token_name, channel_name')
      .eq('user_id', userId)
      .gt('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(500);
    if (error) {
      console.warn(`[MissedRunnerPoller] Slim contract load failed for ${userId}:`, error.message);
      return [];
    }
    return (data ?? []).map((row: any) => ({
      address: row.address,
      chain: row.chain,
      evmChain: row.evm_chain ?? undefined,
      timestamp: row.timestamp,
      fdvAtCall: row.fdv_at_call ?? undefined,
      fdvAtCallDisplay: row.fdv_at_call_display ?? undefined,
      tokenSymbol: row.token_symbol ?? undefined,
      tokenName: row.token_name ?? undefined,
      channelName: row.channel_name ?? undefined,
    })) as ContractEntry[];
  }

  private async loadHoldingWallets(userId: string): Promise<TrackedWalletRow[]> {
    if (!this.db) return [];
    const { data, error } = await this.db
      .from('user_holding_wallets')
      .select('id, address, chain')
      .eq('user_id', userId);
    if (error) {
      console.warn(`[MissedRunnerPoller] Holding wallets load failed for ${userId}:`, error.message);
      return [];
    }
    return (data ?? []) as TrackedWalletRow[];
  }

  private async isOnCooldown(userId: string, tokenAddress: string): Promise<boolean> {
    if (!this.db) return true;
    const { data, error } = await this.db
      .from('missed_runner_alerts')
      .select('cooldown_until')
      .eq('user_id', userId)
      .eq('token_address', tokenAddress.toLowerCase())
      .maybeSingle();
    if (error || !data) return false;
    return new Date(data.cooldown_until).getTime() > Date.now();
  }

  private async recordAlert(
    userId: string,
    token: TokenCandidate,
    mcNow: number,
    multiplier: number,
    cooldownHours: number,
  ): Promise<boolean> {
    if (!this.db) return false;
    // Upsert, not insert: a (user_id, token_address) row already exists after
    // the first alert, and a plain insert would 23505 against the unique key
    // forever after — the row must be refreshed to re-arm the cooldown.
    const { error } = await this.db
      .from('missed_runner_alerts')
      .upsert(buildMissedRunnerAlertRow(userId, token, mcNow, multiplier, cooldownHours), {
        onConflict: 'user_id,token_address',
      });
    if (error) {
      console.error('[MissedRunnerPoller] Failed to record alert:', error.message);
      return false;
    }
    return true;
  }

  private async processUser(userId: string): Promise<void> {
    const storage = getStorageProvider();
    const config = await storage.getConfig(userId);
    const mr = resolveMissedRunnerConfig(config);
    if (!mr.enabled) return;

    const via = resolveNotifyVia(config, mr);
    const sendToast = via === 'toast' || via === 'both';
    const sendPush = (via === 'pushover' || via === 'both') && canSendPushover(config);
    if (!sendToast && !sendPush) return;

    const since = new Date(Date.now() - mr.lookbackHours * 3_600_000).toISOString();
    const contracts = await this.loadContractsSlim(userId, since);
    const candidates = buildTokenCandidates(contracts);
    if (candidates.length === 0) return;

    const wallets = await this.loadHoldingWallets(userId);

    for (const token of candidates) {
      if (mr.minMcAtCall != null && token.mcAtCall < mr.minMcAtCall) continue;
      if (await this.isOnCooldown(userId, token.address)) continue;

      const live = await fetchLiveMarketCap(token.address, token.evmChain ?? undefined);
      if (!live?.mcNow || live.mcNow <= 0) continue;

      // This fetch already happened for the alert check; folding it into the
      // token peaks costs nothing upstream and catches spikes the 3-min
      // sampler sleeps through. The signals stay separate — this feeds the
      // shared peak *data*, not the missed-runner detection.
      recordPeakObservation({
        address: token.address,
        chain: token.chain,
        evmChain: token.evmChain,
        mcNow: live.mcNow,
      });

      const multiplier = live.mcNow / token.mcAtCall;
      if (multiplier < mr.minMultiplier) continue;

      const balance = await checkTokenHeldByWallets(
        token.address,
        token.chain,
        token.evmChain,
        wallets,
      );

      if (balance.skipped) {
        console.log(
          `[MissedRunnerPoller] Skip ${token.address} for ${userId}: ${balance.reason}`,
        );
        continue;
      }
      if (balance.holds) continue;

      const recorded = await this.recordAlert(userId, token, live.mcNow, multiplier, mr.cooldownHours);
      if (!recorded) continue;

      const symbol = token.tokenSymbol ? `$${token.tokenSymbol}` : token.address.slice(0, 8);
      const multLabel = `${multiplier.toFixed(1)}×`;
      const mcFrom = token.mcAtCallDisplay ?? formatCompact(token.mcAtCall);
      const mcTo = live.mcNowDisplay ?? formatCompact(live.mcNow);
      const age = formatMissedRunnerAge(token.firstSeenAt);
      const channel = token.channelName ? `#${token.channelName}` : 'your feed';
      const title = `Missed runner: ${symbol} (${multLabel})`;
      const body = `Scanned ${age} ago in ${channel} · MC ${mcFrom} → ${mcTo} · Not in My Wallets`;

      const url = buildContractUrl(
        token.address,
        config.contractLinkTemplates,
        token.evmChain ?? undefined,
      );

      if (sendToast) {
        this.wsServer.broadcastAlert({
          type: 'missed_runner',
          reason: title,
          message: buildMissedRunnerMessage(token, body, url),
        }, userId);
      }

      if (sendPush) {
        await sendPushover(config.pushover, {
          title,
          message: body,
          url,
          urlTitle: 'Open token',
        });
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.db) return;
    this.polling = true;
    try {
      const userIds = await this.loadActiveUserIds();
      for (const userId of userIds) {
        try {
          await this.processUser(userId);
        } catch (err) {
          console.error(`[MissedRunnerPoller] User ${userId} error:`, (err as Error)?.message);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

let _poller: MissedRunnerPoller | null = null;

export function startMissedRunnerPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new MissedRunnerPoller(wsServer);
  _poller.start();
}

export function stopMissedRunnerPoller(): void {
  _poller?.stop();
  _poller = null;
}
