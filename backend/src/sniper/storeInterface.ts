// SniperStore — rules, wallets, per-day budgets, kill switch, fire log.
//
// A SIBLING of StorageProvider, not an extension: storage/interface.ts is 20
// methods of Discord/Telegram/contract shape and the sniper's shape has nothing
// to do with it (store.ts:3-6, docs/architecture/sniper.md reuse map). It does
// follow that interface's one universal convention — every method takes userId
// first — because InMemorySniperStore took it on none, and a store keyed on
// nothing means one user's kill switch stops everyone's fires and one user's
// budget bounds another's.
//
// Every method is async because the hosted implementation is a network round
// trip. Going half-async was never an option: `store.isKilled()` returning a
// Promise is always truthy, which reads as a permanently-tripped kill switch —
// or, past a `!`, a never-tripped one.
//
// `reserveLeg` is the one method that MUST be atomic; each implementation says
// in its own header how it gets that.

import type {
  BudgetRow,
  Chain,
  FireRecord,
  ReservationResult,
  RuleState,
  SizeUnit,
  SnipeRule,
  SniperFeeSettings,
  WalletConfig,
} from './types.js';

export interface KillState {
  on: boolean;
  reason: string | null;
  trippedAt: number | null;
}

export interface ReserveParams {
  walletId: string;
  chain: Chain;
  unit: SizeUnit;
  /** YYYY-MM-DD, UTC. */
  day: string;
  /** Leg amount PLUS estimated fees. Debiting the swap amount alone makes the daily cap soft. */
  amountWithFees: number;
}

export interface ReleaseParams {
  walletId: string;
  chain: Chain;
  day: string;
  amountWithFees: number;
  closePosition: boolean;
}

export interface ClampCapsParams {
  walletId: string;
  chain: Chain;
  /** YYYY-MM-DD, UTC. Today only — a past day's row is history and must not move. */
  day: string;
  perFireCap: number;
  dailyCap: number;
  maxOpen: number;
}

export interface ResolveFireParams {
  resolution: 'filled' | 'not_filled';
  at: number;
  note?: string;
}

export interface SniperStore {
  putRule(userId: string, rule: SnipeRule): Promise<void>;
  getRule(userId: string, id: string): Promise<SnipeRule | null>;
  listRules(userId: string): Promise<SnipeRule[]>;
  deleteRule(userId: string, id: string): Promise<boolean>;
  setRuleState(userId: string, id: string, state: RuleState): Promise<void>;
  setRuleDryRun(userId: string, id: string, dryRun: boolean): Promise<void>;

  putWallet(userId: string, cfg: WalletConfig): Promise<void>;
  getWallet(userId: string, walletId: string): Promise<WalletConfig | null>;
  listWallets(userId: string): Promise<WalletConfig[]>;
  deleteWallet(userId: string, walletId: string): Promise<boolean>;

  /**
   * The account-level tip + priority fee every rule inherits (fees.ts).
   *
   * MUST NOT throw for a user who has never set them — it returns
   * DEFAULT_FEE_SETTINGS (zeros), which reproduces the pre-global arithmetic
   * exactly. It MAY throw on a real backend failure, and executeFire treats
   * that as an abort rather than firing with fees it could not read: reserving
   * without the tip is how a daily cap goes soft.
   */
  getFeeSettings(userId: string): Promise<SniperFeeSettings>;
  /** Values are validated at the API boundary and normalized again on read. */
  setFeeSettings(userId: string, settings: SniperFeeSettings): Promise<void>;

  isKilled(userId: string): Promise<boolean>;
  getKillState(userId: string): Promise<KillState>;
  setKillSwitch(userId: string, on: boolean, reason: string | null): Promise<void>;

  reserveLeg(userId: string, p: ReserveParams): Promise<ReservationResult>;
  releaseLeg(userId: string, p: ReleaseParams): Promise<void>;

  /**
   * Lower a day's already-snapshotted caps to match a reduced wallet config.
   * MONOTONIC: each column moves down or not at all, never up.
   *
   * Caps are snapshotted when the day's budget row is created, which is right —
   * it stops a mid-day raise from retroactively re-authorising a fire that was
   * already refused. But applied symmetrically it also means LOWERING a cap does
   * nothing until tomorrow, and that is the operator's most likely
   * risk-REDUCING action. A reduction is always safe to apply to a live row: it
   * can only refuse fires that have not happened yet. So the asymmetry is the
   * correct behaviour, not a leak in the snapshot rule.
   *
   * No-op when today has no row yet — the row will be created from the new
   * (lower) wallet config anyway.
   */
  clampBudgetCaps(userId: string, p: ClampCapsParams): Promise<void>;

  budgetSnapshot(userId: string, walletId: string, chain: Chain, day: string): Promise<BudgetRow | null>;
  listBudget(userId: string, day: string): Promise<BudgetRow[]>;

  recordFire(userId: string, rec: Omit<FireRecord, 'id'>): Promise<FireRecord>;
  getFire(userId: string, id: string): Promise<FireRecord | null>;
  fireLog(userId: string, limit?: number): Promise<FireRecord[]>;

  /**
   * Resolve an `unknown` leg. GUARDED and IDEMPOTENT: the transition is
   * conditional inside the same statement that performs it, and only a row that
   * is still `state:'unknown'` with no `resolution` may be written. A second
   * resolve for the same fire returns null and changes nothing.
   *
   * That is not a nicety. The caller credits the leg's reservation back to the
   * day's budget when the operator says `not_filled`, and `releaseLeg` is not
   * itself idempotent — it floors at zero but cannot tell a first release from a
   * second. Without this guard, N concurrent resolves of one fire hand back N
   * times money that was reserved once, which is the one way an authenticated
   * caller can defeat the daily cap. Callers must release ONLY when this returns
   * a row.
   */
  resolveFire(userId: string, id: string, r: ResolveFireParams): Promise<FireRecord | null>;
}

// `armedRules()` is deliberately absent. It had no consumer until a tweet
// dispatcher exists, and the alpha has none — callers use `listRules` plus a
// filter. It comes back with M2, next to the fan-out index that reads it.
