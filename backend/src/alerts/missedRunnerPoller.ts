/**
 * Missed-runner alert poller.
 *
 * Every few minutes, for each user with missedRunner enabled:
 * 1. Load recent contracts with MC@call
 * 2. Dedupe by token; keep earliest scan MC
 * 3. Fetch live MC via DexScreener
 * 4. If multiplier threshold met and user doesn't hold token → Pushover
 * 5. Record dedupe row in missed_runner_alerts
 *
 * Self-gates on Supabase (hosted mode). Idle in local/json mode without Supabase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getFomoServiceClient } from '../fomo/store.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import { fetchLiveMarketCap } from '../utils/tokenEnrichment.js';
import { buildContractUrl } from '../utils/contract.js';
import { checkTokenHeldByWallets, formatCompact, type TrackedWalletRow } from '../wallets/balanceChecker.js';
import type { ContractEntry } from '../utils/contractLog.js';
import type { AppConfig, MissedRunnerConfig } from '../discord/types.js';

const DEFAULT_INTERVAL_MS = 180_000; // 3 min

const DEFAULT_MISSED_RUNNER: MissedRunnerConfig = {
  enabled: false,
  minMultiplier: 1.5,
  lookbackHours: 24,
  cooldownHours: 24,
};

interface TokenCandidate {
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

function resolveMissedRunnerConfig(config: AppConfig): MissedRunnerConfig {
  return { ...DEFAULT_MISSED_RUNNER, ...config.missedRunner };
}

function shouldNotify(config: AppConfig): boolean {
  const mr = resolveMissedRunnerConfig(config);
  const triggers = config.pushover?.triggers ?? {};
  return (
    mr.enabled
    && config.pushover?.enabled
    && !!config.pushover.appToken
    && !!config.pushover.userKey
    && (triggers.missedRunner ?? false)
  );
}

/** Same earliest-scan MC logic as Radar buildRadar. */
function buildTokenCandidates(contracts: ContractEntry[]): TokenCandidate[] {
  const byAddress = new Map<string, ContractEntry[]>();
  for (const c of contracts) {
    if (c.fdvAtCall == null || c.fdvAtCall <= 0) continue;
    const key = c.address.toLowerCase();
    const list = byAddress.get(key) ?? [];
    list.push(c);
    byAddress.set(key, list);
  }

  const out: TokenCandidate[] = [];
  for (const [, group] of byAddress) {
    const earliest = [...group].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )[0];
    if (!earliest?.fdvAtCall) continue;
    out.push({
      address: earliest.address,
      chain: earliest.chain,
      evmChain: earliest.evmChain,
      mcAtCall: earliest.fdvAtCall,
      mcAtCallDisplay: earliest.fdvAtCallDisplay,
      tokenSymbol: earliest.tokenSymbol,
      tokenName: earliest.tokenName,
      channelName: earliest.channelName,
      firstSeenAt: earliest.timestamp,
    });
  }
  return out;
}

function formatAge(firstSeenAt: string): string {
  const mins = Math.floor((Date.now() - new Date(firstSeenAt).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

class MissedRunnerPoller {
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private started = false;

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

  private async loadActiveUserIds(): Promise<string[]> {
    if (!this.db) return [];
    const { data, error } = await this.db.from('user_configs').select('user_id, settings');
    if (error) {
      console.warn('[MissedRunnerPoller] Failed to load user configs:', error.message);
      return [];
    }
    return (data ?? [])
      .filter((row) => {
        const settings = (row.settings ?? {}) as Partial<Pick<AppConfig, 'missedRunner' | 'pushover'>>;
        const mr = { ...DEFAULT_MISSED_RUNNER, ...settings.missedRunner };
        const triggers = settings.pushover?.triggers;
        return mr.enabled && settings.pushover?.enabled && (triggers?.missedRunner ?? false);
      })
      .map((row) => row.user_id as string);
  }

  private async loadTrackedWallets(userId: string): Promise<TrackedWalletRow[]> {
    if (!this.db) return [];
    const { data, error } = await this.db
      .from('user_tracked_wallets')
      .select('id, address, chain')
      .eq('user_id', userId);
    if (error) {
      console.warn(`[MissedRunnerPoller] Wallets load failed for ${userId}:`, error.message);
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
      .ilike('token_address', tokenAddress)
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
    const cooldownUntil = new Date(Date.now() + cooldownHours * 3_600_000).toISOString();
    const { error } = await this.db.from('missed_runner_alerts').insert({
      user_id: userId,
      token_address: token.address.toLowerCase(),
      mc_at_call: token.mcAtCall,
      mc_now: mcNow,
      multiplier,
      channel_name: token.channelName ?? null,
      token_symbol: token.tokenSymbol ?? null,
      cooldown_until: cooldownUntil,
    });
    if (error) {
      if ((error as { code?: string }).code === '23505') return false;
      console.error('[MissedRunnerPoller] Failed to record alert:', error.message);
      return false;
    }
    return true;
  }

  private async processUser(userId: string): Promise<void> {
    const storage = getStorageProvider();
    const config = await storage.getConfig(userId);
    if (!shouldNotify(config)) return;

    const mr = resolveMissedRunnerConfig(config);
    const since = new Date(Date.now() - mr.lookbackHours * 3_600_000).toISOString();
    const contracts = await storage.getContracts(userId, 500, since);
    const candidates = buildTokenCandidates(contracts);
    if (candidates.length === 0) return;

    const wallets = await this.loadTrackedWallets(userId);

    for (const token of candidates) {
      if (mr.minMcAtCall != null && token.mcAtCall < mr.minMcAtCall) continue;
      if (await this.isOnCooldown(userId, token.address)) continue;

      const live = await fetchLiveMarketCap(token.address);
      if (!live?.mcNow || live.mcNow <= 0) continue;

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
      const age = formatAge(token.firstSeenAt);
      const channel = token.channelName ? `#${token.channelName}` : 'your feed';

      const url = buildContractUrl(
        token.address,
        config.contractLinkTemplates,
        token.evmChain ?? undefined,
      );

      await sendPushover(config.pushover, {
        title: `Missed runner: ${symbol} (${multLabel})`,
        message: `Scanned ${age} ago in ${channel} · MC ${mcFrom} → ${mcTo} · Not in your wallets`,
        url,
        urlTitle: 'Open token',
      });
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

export function startMissedRunnerPoller(): void {
  if (_poller) return;
  _poller = new MissedRunnerPoller();
  _poller.start();
}

export function stopMissedRunnerPoller(): void {
  _poller?.stop();
  _poller = null;
}
