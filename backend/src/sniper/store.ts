// InMemorySniperStore — the reference SniperStore implementation.
//
// It is no longer the only one (see stores/jsonSniperStore.ts and
// stores/supabaseSniperStore.ts), but it stays: it is the fastest correct
// implementation for unit tests, and it is the definition of what the other two
// must do. When the three disagree, this file is right.
//
// The reservation (`reserveLeg`) is the one method that must be atomic. Here
// "atomic" is free — Node is single-threaded and the check and the mutation
// happen in one function with no `await` between them. In hosted mode it becomes
// the single `sniper_reserve_leg` plpgsql call, whose predicate keys on
// (wallet_id, chain, day, unit) for the same reason the signature below does.

import { randomUUID } from 'crypto';
import type {
  SniperStore,
  ClampCapsParams,
  KillState,
  ReserveParams,
  ReleaseParams,
  ResolveFireParams,
} from './storeInterface.js';
import type {
  BudgetRow,
  Chain,
  FireRecord,
  ReservationResult,
  RuleState,
  SnipeRule,
  WalletConfig,
} from './types.js';

// Re-exported so the many existing importers of `WalletConfig`/`FireRecord`
// from this module keep working; the definitions moved to types.ts because
// three store implementations and the API layer all speak them now.
export type { WalletConfig, FireRecord } from './types.js';

/** YYYY-MM-DD in UTC, from an injected clock so tests are deterministic. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Composite map key. NUL separator, same reasoning as idempotency.ts:39-45 — it
 * cannot appear in a userId, rule id or wallet id, so two distinct pairs can
 * never collide into one key the way a space separator could. Written as an
 * escape so this file stays plain text to git and grep.
 */
function key(...parts: string[]): string {
  return parts.join('\u0000');
}

interface UserState {
  killSwitch: boolean;
  trippedAt: number | null;
  trippedReason: string | null;
}

export class InMemorySniperStore implements SniperStore {
  private rules = new Map<string, SnipeRule>();
  private wallets = new Map<string, WalletConfig>();
  private budgets = new Map<string, BudgetRow>();
  private state = new Map<string, UserState>();
  private fires = new Map<string, FireRecord>();

  // --- rules ---
  async putRule(userId: string, rule: SnipeRule): Promise<void> {
    this.rules.set(key(userId, rule.id), { ...rule, userId });
  }
  async getRule(userId: string, id: string): Promise<SnipeRule | null> {
    return this.rules.get(key(userId, id)) ?? null;
  }
  async listRules(userId: string): Promise<SnipeRule[]> {
    return [...this.rules.values()].filter((r) => r.userId === userId);
  }
  async deleteRule(userId: string, id: string): Promise<boolean> {
    return this.rules.delete(key(userId, id));
  }
  async setRuleState(userId: string, id: string, state: RuleState): Promise<void> {
    const r = this.rules.get(key(userId, id));
    if (r) r.state = state;
  }
  async setRuleDryRun(userId: string, id: string, dryRun: boolean): Promise<void> {
    const r = this.rules.get(key(userId, id));
    if (r) r.dryRun = dryRun;
  }

  // --- wallets ---
  async putWallet(userId: string, cfg: WalletConfig): Promise<void> {
    this.wallets.set(key(userId, cfg.walletId), cfg);
  }
  async getWallet(userId: string, walletId: string): Promise<WalletConfig | null> {
    return this.wallets.get(key(userId, walletId)) ?? null;
  }
  async listWallets(userId: string): Promise<WalletConfig[]> {
    const out: WalletConfig[] = [];
    for (const [k, v] of this.wallets) {
      if (k.startsWith(`${userId}\u0000`)) out.push(v);
    }
    return out;
  }
  async deleteWallet(userId: string, walletId: string): Promise<boolean> {
    return this.wallets.delete(key(userId, walletId));
  }

  // --- kill switch ---
  async isKilled(userId: string): Promise<boolean> {
    return this.state.get(userId)?.killSwitch ?? false;
  }
  async getKillState(userId: string): Promise<KillState> {
    const s = this.state.get(userId);
    return { on: s?.killSwitch ?? false, reason: s?.trippedReason ?? null, trippedAt: s?.trippedAt ?? null };
  }
  async setKillSwitch(userId: string, on: boolean, reason: string | null): Promise<void> {
    this.state.set(userId, {
      killSwitch: on,
      trippedAt: on ? Date.now() : null,
      trippedReason: on ? reason : null,
    });
  }

  private budgetKey(userId: string, walletId: string, chain: Chain, day: string): string {
    return key(userId, walletId, chain, day);
  }

  /** Upsert the day's budget row from wallet config — this is the rollover guard. */
  private ensureBudget(userId: string, walletId: string, chain: Chain, day: string): BudgetRow | null {
    const k = this.budgetKey(userId, walletId, chain, day);
    const existing = this.budgets.get(k);
    if (existing) return existing;
    const cfg = this.wallets.get(key(userId, walletId));
    if (!cfg || cfg.chain !== chain) return null;
    const row: BudgetRow = {
      walletId,
      chain,
      unit: cfg.unit,
      day,
      perFireCap: cfg.perFireCap,
      dailyCap: cfg.dailyCap,
      maxOpen: cfg.maxOpen,
      spentToday: 0,
      openPositions: 0,
    };
    this.budgets.set(k, row);
    return row;
  }

  /**
   * Atomically reserve `amountWithFees` (native units, fees included) against a
   * wallet's day budget. Returns ok only if it debited exactly one row. The unit
   * check prevents comparing incommensurable numbers (5 SOL vs a 1000-USDC cap).
   */
  async reserveLeg(userId: string, params: ReserveParams): Promise<ReservationResult> {
    const row = this.ensureBudget(userId, params.walletId, params.chain, params.day);
    if (!row) return { ok: false, reason: 'no_wallet' };
    if (row.unit !== params.unit) return { ok: false, reason: 'unit_mismatch' };
    if (params.amountWithFees > row.perFireCap) return { ok: false, reason: 'per_fire_cap' };
    if (row.spentToday + params.amountWithFees > row.dailyCap) return { ok: false, reason: 'daily_cap' };
    if (row.openPositions >= row.maxOpen) return { ok: false, reason: 'max_open' };

    row.spentToday += params.amountWithFees;
    row.openPositions += 1;
    return { ok: true };
  }

  /** Release a reservation (a provably-dead send, or a dry-run synthetic close). */
  async releaseLeg(userId: string, params: ReleaseParams): Promise<void> {
    const row = this.budgets.get(this.budgetKey(userId, params.walletId, params.chain, params.day));
    if (!row) return;
    row.spentToday = Math.max(0, row.spentToday - params.amountWithFees);
    if (params.closePosition) row.openPositions = Math.max(0, row.openPositions - 1);
  }

  /** Lower today's snapshotted caps to a reduced wallet config. Never raises. */
  async clampBudgetCaps(userId: string, p: ClampCapsParams): Promise<void> {
    const row = this.budgets.get(this.budgetKey(userId, p.walletId, p.chain, p.day));
    if (!row) return;
    row.perFireCap = Math.min(row.perFireCap, p.perFireCap);
    row.dailyCap = Math.min(row.dailyCap, p.dailyCap);
    row.maxOpen = Math.min(row.maxOpen, p.maxOpen);
  }

  async budgetSnapshot(userId: string, walletId: string, chain: Chain, day: string): Promise<BudgetRow | null> {
    return this.budgets.get(this.budgetKey(userId, walletId, chain, day)) ?? null;
  }

  async listBudget(userId: string, day: string): Promise<BudgetRow[]> {
    const prefix = `${userId}\u0000`;
    const out: BudgetRow[] = [];
    for (const [k, row] of this.budgets) {
      if (k.startsWith(prefix) && row.day === day) out.push(row);
    }
    return out;
  }

  // --- fire log (reconciliation substrate) ---
  async recordFire(userId: string, rec: Omit<FireRecord, 'id'>): Promise<FireRecord> {
    // Upsert on (rule, trigger, wallet, leg) rather than append, mirroring the
    // hosted store's ON CONFLICT target so a retry updates `attempts` in place
    // instead of producing a second row for the same leg.
    const prior = [...this.fires.values()].find(
      (f) =>
        f.userId === userId &&
        f.ruleId === rec.ruleId &&
        f.triggerKey === rec.triggerKey &&
        f.walletId === rec.walletId &&
        f.legNo === rec.legNo,
    );
    const row: FireRecord = { ...rec, userId, id: prior?.id ?? randomUUID() };
    this.fires.set(row.id, row);
    return row;
  }

  async getFire(userId: string, id: string): Promise<FireRecord | null> {
    const f = this.fires.get(id);
    return f && f.userId === userId ? f : null;
  }

  async fireLog(userId: string, limit = 200): Promise<FireRecord[]> {
    return [...this.fires.values()]
      .filter((f) => f.userId === userId)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  async resolveFire(userId: string, id: string, r: ResolveFireParams): Promise<FireRecord | null> {
    const f = this.fires.get(id);
    if (!f || f.userId !== userId) return null;
    // The guard and the write happen with no `await` between them, which is what
    // makes the transition atomic here — the same property `reserveLeg` relies
    // on. Returning null rather than re-writing is what makes a second resolve a
    // no-op instead of a second budget credit; see storeInterface.resolveFire.
    if (f.state !== 'unknown' || f.resolution) return null;
    f.resolution = r.resolution;
    f.resolvedAt = r.at;
    f.resolvedNote = r.note;
    // `not_filled` means the operator checked the venue and the send never
    // landed, so the leg is no longer indeterminate — it expired.
    if (r.resolution === 'not_filled') f.state = 'expired';
    return f;
  }
}
