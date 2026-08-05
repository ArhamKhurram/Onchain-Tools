// SniperStore — rules, wallets, per-day budgets, kill switch, and the fire log.
//
// M1 is an in-memory implementation. It is deliberately a SIBLING of the generic
// StorageProvider, not an extension: the sniper's shape (budgets, fires, kill
// switch) has nothing to do with Discord/Telegram/contract persistence.
//
// The reservation (`reserveLeg`) is the one method that must be atomic. In this
// in-memory store, "atomic" is free — Node is single-threaded and the check and
// the mutation happen in one synchronous function with no `await` between them.
// In hosted mode this becomes the single UPDATE ... RETURNING statement in the
// docs, whose predicate keys on (wallet_id, chain, day, unit) for the same reason
// the signature below does.

import type {
  BudgetRow,
  Chain,
  ReservationResult,
  SizeUnit,
  SnipeRule,
} from './types.js';

export interface WalletConfig {
  walletId: string;
  chain: Chain;
  unit: SizeUnit;
  /** Caps a single leg. The authoritative per-fire cap is min(this, rule.perFireCap). */
  perFireCap: number;
  /** Total native-unit spend allowed per UTC day. */
  dailyCap: number;
  /** Max simultaneously-open positions. */
  maxOpen: number;
}

export interface FireRecord {
  ruleId: string;
  userId: string;
  triggerKey: string;
  walletId: string;
  legNo: number;
  mint: string;
  amount: number;
  state: 'filled' | 'expired' | 'aborted' | 'unknown';
  signature?: string;
  abortReason?: string;
  at: number;
}

/** YYYY-MM-DD in UTC, from an injected clock so tests are deterministic. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class InMemorySniperStore {
  private rules = new Map<string, SnipeRule>();
  private wallets = new Map<string, WalletConfig>();
  private budgets = new Map<string, BudgetRow>();
  private killSwitch = false;
  private fires: FireRecord[] = [];

  // --- rules ---
  putRule(rule: SnipeRule): void {
    this.rules.set(rule.id, rule);
  }
  getRule(id: string): SnipeRule | undefined {
    return this.rules.get(id);
  }
  armedRules(): SnipeRule[] {
    return [...this.rules.values()].filter((r) => r.state === 'armed');
  }
  setRuleState(id: string, state: SnipeRule['state']): void {
    const r = this.rules.get(id);
    if (r) r.state = state;
  }

  // --- wallets ---
  putWallet(cfg: WalletConfig): void {
    this.wallets.set(cfg.walletId, cfg);
  }
  getWallet(id: string): WalletConfig | undefined {
    return this.wallets.get(id);
  }

  // --- kill switch (survives conceptually; here it is process state) ---
  isKilled(): boolean {
    return this.killSwitch;
  }
  setKillSwitch(on: boolean): void {
    this.killSwitch = on;
  }

  private budgetKey(walletId: string, chain: Chain, day: string): string {
    return `${walletId} ${chain} ${day}`;
  }

  /** Upsert the day's budget row from wallet config — this is the rollover guard. */
  private ensureBudget(walletId: string, chain: Chain, day: string): BudgetRow | null {
    const key = this.budgetKey(walletId, chain, day);
    const existing = this.budgets.get(key);
    if (existing) return existing;
    const cfg = this.wallets.get(walletId);
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
    this.budgets.set(key, row);
    return row;
  }

  /**
   * Atomically reserve `amountWithFees` (native units, fees included) against a
   * wallet's day budget. Returns ok only if it debited exactly one row. The unit
   * check prevents comparing incommensurable numbers (5 SOL vs a 1000-USDC cap).
   */
  reserveLeg(params: {
    walletId: string;
    chain: Chain;
    unit: SizeUnit;
    day: string;
    amountWithFees: number;
  }): ReservationResult {
    const row = this.ensureBudget(params.walletId, params.chain, params.day);
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
  releaseLeg(params: {
    walletId: string;
    chain: Chain;
    day: string;
    amountWithFees: number;
    closePosition: boolean;
  }): void {
    const row = this.budgets.get(this.budgetKey(params.walletId, params.chain, params.day));
    if (!row) return;
    row.spentToday = Math.max(0, row.spentToday - params.amountWithFees);
    if (params.closePosition) row.openPositions = Math.max(0, row.openPositions - 1);
  }

  budgetSnapshot(walletId: string, chain: Chain, day: string): BudgetRow | undefined {
    return this.budgets.get(this.budgetKey(walletId, chain, day));
  }

  // --- fire log (reconciliation substrate) ---
  recordFire(rec: FireRecord): void {
    this.fires.push(rec);
  }
  fireLog(): readonly FireRecord[] {
    return this.fires;
  }
}
