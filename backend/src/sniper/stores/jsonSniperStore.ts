// JsonSniperStore — the LOCAL-mode SniperStore.
//
// Backing file: <OCT_DATA_DIR>/sniper.json, load-once into a module cache then
// writeFileSync after each mutation. Same shape and same failure handling as
// alerts/tokenPeakStore.ts (load/save, catch-and-log-only) and config/store.ts,
// including the dual OCT_*/TRENCHCORD_* env branding.
//
// ATOMICITY. The reservation is atomic here for the same reason it is in
// InMemorySniperStore: Node is single-threaded and the check, the mutation and
// the sync write happen with no `await` between them. That is correct for
// exactly one backend process, which is what local mode is (loopback, one
// operator, ADR-008). It is NOT safe for two processes sharing a data dir —
// there is no file lock, and none is added. Documented rather than defended
// against, because local mode has no second writer by construction.
//
// The file is keyed by userId even though local mode only ever has 'local'. It
// costs two lines and means a future multi-user local install is not a rewrite.

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  ClampCapsParams,
  KillState,
  ReleaseParams,
  ReserveParams,
  ResolveFireParams,
  SniperStore,
} from '../storeInterface.js';
import type {
  BudgetRow,
  Chain,
  FireRecord,
  ReservationResult,
  RuleState,
  SnipeRule,
  WalletConfig,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../../data');
const LOCAL_PATH = join(DATA_DIR, 'sniper.json');

/**
 * The fire log is the reconciliation substrate, so it must not be trimmed
 * casually — but it must also not grow without bound on a desktop install that
 * runs for months. Oldest rows drop first; an unresolved `unknown` older than
 * 5000 fires is a problem no cap can fix.
 */
const MAX_FIRES = 5000;

interface UserBucket {
  rules: Record<string, SnipeRule>;
  wallets: Record<string, WalletConfig>;
  budgets: Record<string, BudgetRow>;
  fires: FireRecord[];
  state: { killSwitch: boolean; trippedAt: number | null; trippedReason: string | null };
}

type FileShape = Record<string, UserBucket>;

let cache: FileShape | null = null;

function emptyBucket(): UserBucket {
  return {
    rules: {},
    wallets: {},
    budgets: {},
    fires: [],
    state: { killSwitch: false, trippedAt: null, trippedReason: null },
  };
}

function load(): FileShape {
  if (cache) return cache;
  try {
    cache = existsSync(LOCAL_PATH) ? (JSON.parse(readFileSync(LOCAL_PATH, 'utf-8')) as FileShape) : {};
  } catch (err) {
    // Same posture as tokenPeakStore: a corrupt file must not stop the server
    // booting. It DOES mean the operator's caps and kill switch reset, which is
    // why the failure is logged loudly rather than swallowed.
    console.error('[Sniper] Failed to load sniper.json:', (err as Error).message);
    cache = {};
  }
  return cache;
}

function save(): void {
  try {
    writeFileSync(LOCAL_PATH, JSON.stringify(cache ?? {}, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Sniper] Failed to save sniper.json:', (err as Error).message);
  }
}

function bucket(userId: string): UserBucket {
  const store = load();
  const existing = store[userId];
  if (existing) {
    // Defensive: a hand-edited or older file may be missing a sub-object.
    existing.rules ??= {};
    existing.wallets ??= {};
    existing.budgets ??= {};
    existing.fires ??= [];
    existing.state ??= { killSwitch: false, trippedAt: null, trippedReason: null };
    return existing;
  }
  const fresh = emptyBucket();
  store[userId] = fresh;
  return fresh;
}

function budgetKey(walletId: string, chain: Chain, day: string): string {
  return `${walletId}|${chain}|${day}`;
}

export class JsonSniperStore implements SniperStore {
  // --- rules ---
  async putRule(userId: string, rule: SnipeRule): Promise<void> {
    bucket(userId).rules[rule.id] = { ...rule, userId };
    save();
  }
  async getRule(userId: string, id: string): Promise<SnipeRule | null> {
    return bucket(userId).rules[id] ?? null;
  }
  async listRules(userId: string): Promise<SnipeRule[]> {
    return Object.values(bucket(userId).rules);
  }
  async deleteRule(userId: string, id: string): Promise<boolean> {
    const b = bucket(userId);
    if (!b.rules[id]) return false;
    delete b.rules[id];
    save();
    return true;
  }
  async setRuleState(userId: string, id: string, state: RuleState): Promise<void> {
    const rule = bucket(userId).rules[id];
    if (!rule) return;
    rule.state = state;
    save();
  }
  async setRuleDryRun(userId: string, id: string, dryRun: boolean): Promise<void> {
    const rule = bucket(userId).rules[id];
    if (!rule) return;
    rule.dryRun = dryRun;
    save();
  }

  // --- wallets ---
  async putWallet(userId: string, cfg: WalletConfig): Promise<void> {
    bucket(userId).wallets[cfg.walletId] = cfg;
    save();
  }
  async getWallet(userId: string, walletId: string): Promise<WalletConfig | null> {
    return bucket(userId).wallets[walletId] ?? null;
  }
  async listWallets(userId: string): Promise<WalletConfig[]> {
    return Object.values(bucket(userId).wallets);
  }
  async deleteWallet(userId: string, walletId: string): Promise<boolean> {
    const b = bucket(userId);
    if (!b.wallets[walletId]) return false;
    delete b.wallets[walletId];
    // Budget rows are keyed on the wallet, so they go with it — mirroring the
    // hosted `on delete cascade`. Fire rows deliberately survive: deleting a
    // wallet must never delete the record of money it moved.
    for (const k of Object.keys(b.budgets)) {
      if (k.startsWith(`${walletId}|`)) delete b.budgets[k];
    }
    save();
    return true;
  }

  // --- kill switch ---
  async isKilled(userId: string): Promise<boolean> {
    return bucket(userId).state.killSwitch;
  }
  async getKillState(userId: string): Promise<KillState> {
    const s = bucket(userId).state;
    return { on: s.killSwitch, reason: s.trippedReason, trippedAt: s.trippedAt };
  }
  async setKillSwitch(userId: string, on: boolean, reason: string | null): Promise<void> {
    const b = bucket(userId);
    b.state = { killSwitch: on, trippedAt: on ? Date.now() : null, trippedReason: on ? reason : null };
    save();
  }

  // --- budget ---
  private ensureBudget(userId: string, walletId: string, chain: Chain, day: string): BudgetRow | null {
    const b = bucket(userId);
    const k = budgetKey(walletId, chain, day);
    const existing = b.budgets[k];
    if (existing) return existing;
    const cfg = b.wallets[walletId];
    if (!cfg || cfg.chain !== chain) return null;
    // Caps are SNAPSHOTTED at rollover, exactly like the hosted insert, so
    // raising a cap mid-day cannot retroactively re-authorise a refused fire.
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
    b.budgets[k] = row;
    return row;
  }

  async reserveLeg(userId: string, params: ReserveParams): Promise<ReservationResult> {
    const row = this.ensureBudget(userId, params.walletId, params.chain, params.day);
    if (!row) return { ok: false, reason: 'no_wallet' };
    if (row.unit !== params.unit) return { ok: false, reason: 'unit_mismatch' };
    if (params.amountWithFees > row.perFireCap) return { ok: false, reason: 'per_fire_cap' };
    if (row.spentToday + params.amountWithFees > row.dailyCap) return { ok: false, reason: 'daily_cap' };
    if (row.openPositions >= row.maxOpen) return { ok: false, reason: 'max_open' };

    row.spentToday += params.amountWithFees;
    row.openPositions += 1;
    save();
    return { ok: true };
  }

  async releaseLeg(userId: string, params: ReleaseParams): Promise<void> {
    const b = bucket(userId);
    const row = b.budgets[budgetKey(params.walletId, params.chain, params.day)];
    if (!row) return;
    row.spentToday = Math.max(0, row.spentToday - params.amountWithFees);
    if (params.closePosition) row.openPositions = Math.max(0, row.openPositions - 1);
    save();
  }

  /** Lower today's snapshotted caps to a reduced wallet config. Never raises. */
  async clampBudgetCaps(userId: string, p: ClampCapsParams): Promise<void> {
    const row = bucket(userId).budgets[budgetKey(p.walletId, p.chain, p.day)];
    if (!row) return;
    row.perFireCap = Math.min(row.perFireCap, p.perFireCap);
    row.dailyCap = Math.min(row.dailyCap, p.dailyCap);
    row.maxOpen = Math.min(row.maxOpen, p.maxOpen);
    save();
  }

  async budgetSnapshot(userId: string, walletId: string, chain: Chain, day: string): Promise<BudgetRow | null> {
    return bucket(userId).budgets[budgetKey(walletId, chain, day)] ?? null;
  }

  async listBudget(userId: string, day: string): Promise<BudgetRow[]> {
    return Object.values(bucket(userId).budgets).filter((r) => r.day === day);
  }

  // --- fire log ---
  async recordFire(userId: string, rec: Omit<FireRecord, 'id'>): Promise<FireRecord> {
    const b = bucket(userId);
    // Upsert on (rule, trigger, wallet, leg), mirroring the hosted unique
    // constraint: a retry updates `attempts` in place rather than adding a
    // second row for the same leg.
    const idx = b.fires.findIndex(
      (f) =>
        f.ruleId === rec.ruleId &&
        f.triggerKey === rec.triggerKey &&
        f.walletId === rec.walletId &&
        f.legNo === rec.legNo,
    );
    const row: FireRecord = { ...rec, userId, id: idx >= 0 ? b.fires[idx].id : randomUUID() };
    if (idx >= 0) b.fires[idx] = row;
    else b.fires.push(row);
    if (b.fires.length > MAX_FIRES) b.fires.splice(0, b.fires.length - MAX_FIRES);
    save();
    return row;
  }

  async getFire(userId: string, id: string): Promise<FireRecord | null> {
    return bucket(userId).fires.find((f) => f.id === id) ?? null;
  }

  async fireLog(userId: string, limit = 200): Promise<FireRecord[]> {
    return [...bucket(userId).fires].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async resolveFire(userId: string, id: string, r: ResolveFireParams): Promise<FireRecord | null> {
    const b = bucket(userId);
    const row = b.fires.find((f) => f.id === id);
    if (!row) return null;
    // Guarded transition, same shape as the hosted store's conditional UPDATE:
    // only a still-unresolved `unknown` leg may be written, so a second resolve
    // is a no-op rather than a second credit against the day's budget. The check
    // and the write share one synchronous block, which is what makes it atomic
    // for the single local process (see this file's ATOMICITY note).
    if (row.state !== 'unknown' || row.resolution) return null;
    row.resolution = r.resolution;
    row.resolvedAt = r.at;
    row.resolvedNote = r.note;
    // `not_filled` means the operator checked the venue and the send never
    // landed, so the leg stops being indeterminate — it expired.
    if (r.resolution === 'not_filled') row.state = 'expired';
    save();
    return row;
  }
}

/** Test seam — drops the in-memory cache, matching resetLocalPeakCache. */
export function resetLocalSniperCache(): void {
  cache = null;
}
