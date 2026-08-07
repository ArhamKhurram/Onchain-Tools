// SupabaseSniperStore — the HOSTED-mode SniperStore.
//
// Backed by supabase/migrations/20260807120000_sniper_rules_fires_budget.sql.
// It uses its own service-role client rather than the generic StorageProvider,
// which is the ADR-007 bypass case: these are hosted-only, service-role tables
// with no browser write path at all, and StorageProvider's 20 methods are a
// Discord/Telegram/contract shape that has nothing to say about budgets.
//
// Every query filters `.eq('user_id', userId)` EXPLICITLY even though the
// service role bypasses RLS. That filter is the only thing scoping these reads;
// its absence would be a cross-tenant read, not a slow query.
//
// The generated Supabase types (packages/shared/src/database.types.ts) do not
// carry these tables — they are regenerated separately and must never be
// hand-edited — so rows are cast to the local domain shapes at the boundary,
// exactly as frontend/src/hooks/useTrackedWallets.ts does.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  EntryStyle,
  ExecParams,
  FireRecord,
  InteractionType,
  MatcherNode,
  ReservationResult,
  RuleState,
  SizeUnit,
  SnipeRule,
  Venue,
  WalletConfig,
} from '../types.js';

let _client: SupabaseClient | null = null;

/** Lazy service client, same shape as tokenPeakStore.ts:37-42 / venueCredentials.ts:23-36. */
function serviceClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required for the hosted sniper store.');
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/** Every ReservationResult reason the SQL can return. */
const RESERVATION_REASONS = [
  'per_fire_cap',
  'daily_cap',
  'max_open',
  'unit_mismatch',
  'no_wallet',
  'contended',
] as const;

type ReservationReason = (typeof RESERVATION_REASONS)[number];

function narrowReservationReason(raw: unknown): ReservationReason {
  // An UNRECOGNISED string must fall through to `contended`, never to ok:true.
  // A store that reports success on a reason it does not understand spends money
  // it was refused.
  return RESERVATION_REASONS.includes(raw as ReservationReason) ? (raw as ReservationReason) : 'contended';
}

export class SupabaseSniperStore implements SniperStore {
  // --- rules ---
  async putRule(userId: string, rule: SnipeRule): Promise<void> {
    const { error } = await serviceClient()
      .from('sniper_rules')
      .upsert(fromRule(userId, rule), { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }

  async getRule(userId: string, id: string): Promise<SnipeRule | null> {
    const { data, error } = await serviceClient()
      .from('sniper_rules')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toRule(data) : null;
  }

  async listRules(userId: string): Promise<SnipeRule[]> {
    const { data, error } = await serviceClient()
      .from('sniper_rules')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map(toRule);
  }

  async deleteRule(userId: string, id: string): Promise<boolean> {
    const { data, error } = await serviceClient()
      .from('sniper_rules')
      .delete()
      .eq('user_id', userId)
      .eq('id', id)
      .select('id');
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  }

  async setRuleState(userId: string, id: string, state: RuleState): Promise<void> {
    const { error } = await serviceClient()
      .from('sniper_rules')
      .update({ state })
      .eq('user_id', userId)
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  async setRuleDryRun(userId: string, id: string, dryRun: boolean): Promise<void> {
    const { error } = await serviceClient()
      .from('sniper_rules')
      .update({ dry_run: dryRun })
      .eq('user_id', userId)
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  // --- wallets ---
  async putWallet(userId: string, cfg: WalletConfig): Promise<void> {
    const { error } = await serviceClient()
      .from('sniper_wallets')
      .upsert(fromWallet(userId, cfg), { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }

  async getWallet(userId: string, walletId: string): Promise<WalletConfig | null> {
    const { data, error } = await serviceClient()
      .from('sniper_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('id', walletId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toWallet(data) : null;
  }

  async listWallets(userId: string): Promise<WalletConfig[]> {
    const { data, error } = await serviceClient()
      .from('sniper_wallets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(toWallet);
  }

  async deleteWallet(userId: string, walletId: string): Promise<boolean> {
    const { data, error } = await serviceClient()
      .from('sniper_wallets')
      .delete()
      .eq('user_id', userId)
      .eq('id', walletId)
      .select('id');
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  }

  // --- kill switch ---
  async isKilled(userId: string): Promise<boolean> {
    return (await this.getKillState(userId)).on;
  }

  async getKillState(userId: string): Promise<KillState> {
    const { data, error } = await serviceClient()
      .from('sniper_state')
      .select('kill_switch, tripped_at, tripped_reason')
      .eq('user_id', userId)
      .maybeSingle();
    // A read failure must NOT be reported as "not killed". executeFire re-reads
    // this before every leg attempt, so a transient Supabase blip that answered
    // `false` would resume firing against a switch the operator has tripped.
    // Throwing surfaces as an aborted fire, which is the safe direction.
    if (error) throw new Error(error.message);
    const row = data as { kill_switch?: boolean; tripped_at?: string | null; tripped_reason?: string | null } | null;
    return {
      on: row?.kill_switch ?? false,
      reason: row?.tripped_reason ?? null,
      trippedAt: row?.tripped_at ? Date.parse(row.tripped_at) : null,
    };
  }

  async setKillSwitch(userId: string, on: boolean, reason: string | null): Promise<void> {
    const { error } = await serviceClient().from('sniper_state').upsert(
      {
        user_id: userId,
        kill_switch: on,
        tripped_at: on ? new Date().toISOString() : null,
        tripped_reason: on ? reason : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    if (error) throw new Error(error.message);
  }

  // --- budget ---
  async reserveLeg(userId: string, p: ReserveParams): Promise<ReservationResult> {
    const { data, error } = await serviceClient().rpc('sniper_reserve_leg', {
      p_user_id: userId,
      p_wallet_id: p.walletId,
      p_chain: p.chain,
      p_unit: p.unit,
      p_day: p.day,
      p_amount: p.amountWithFees,
    });

    if (error) {
      // Names the wallet only. Never the amount alongside the user, and never a
      // token — there is none in this path, and this is the habit that keeps it
      // that way.
      console.error(`[Sniper] reserveLeg RPC failed for wallet ${p.walletId}:`, error.message);
      return { ok: false, reason: 'contended' };
    }
    if (data === null || data === undefined) return { ok: true };
    return { ok: false, reason: narrowReservationReason(data) };
  }

  async releaseLeg(userId: string, p: ReleaseParams): Promise<void> {
    const { error } = await serviceClient().rpc('sniper_release_leg', {
      p_user_id: userId,
      p_wallet_id: p.walletId,
      p_chain: p.chain,
      p_day: p.day,
      p_amount: p.amountWithFees,
      p_close_position: p.closePosition,
    });
    if (error) console.error(`[Sniper] releaseLeg RPC failed for wallet ${p.walletId}:`, error.message);
  }

  /**
   * Lower today's snapshotted caps to a reduced wallet config. Never raises.
   *
   * Three guarded UPDATEs rather than one `least()` statement, because PostgREST
   * cannot express a per-column `least()` and adding an RPC would mean another
   * hand-applied migration against two projects for a cold-path config edit.
   * Each statement is atomic and MONOTONIC — `.gt()` means it can only ever move
   * a column down — so concurrent edits and retries converge on the minimum
   * instead of racing, which is the property that matters here.
   */
  async clampBudgetCaps(userId: string, p: ClampCapsParams): Promise<void> {
    const client = serviceClient();
    const columns: [string, number][] = [
      ['per_fire_cap', p.perFireCap],
      ['daily_cap', p.dailyCap],
      ['max_open', p.maxOpen],
    ];

    for (const [column, value] of columns) {
      const { error } = await client
        .from('sniper_budget')
        .update({ [column]: value })
        .eq('user_id', userId)
        .eq('wallet_id', p.walletId)
        .eq('chain', p.chain)
        .eq('day', p.day)
        .gt(column, value);
      // Logged, not thrown: the wallet row itself has already been written with
      // the lower cap, so tomorrow binds correctly either way, and a failure
      // here must not surface as a failed wallet edit that the operator then
      // retries into a confusing state. It names the wallet only.
      if (error) {
        console.error(`[Sniper] clampBudgetCaps(${column}) failed for wallet ${p.walletId}:`, error.message);
      }
    }
  }

  async budgetSnapshot(userId: string, walletId: string, chain: Chain, day: string): Promise<BudgetRow | null> {
    const { data, error } = await serviceClient()
      .from('sniper_budget')
      .select('*')
      .eq('user_id', userId)
      .eq('wallet_id', walletId)
      .eq('chain', chain)
      .eq('day', day)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toBudget(data) : null;
  }

  async listBudget(userId: string, day: string): Promise<BudgetRow[]> {
    const { data, error } = await serviceClient()
      .from('sniper_budget')
      .select('*')
      .eq('user_id', userId)
      .eq('day', day);
    if (error) throw new Error(error.message);
    return (data ?? []).map(toBudget);
  }

  // --- fire log ---
  async recordFire(userId: string, rec: Omit<FireRecord, 'id'>): Promise<FireRecord> {
    const { data, error } = await serviceClient()
      .from('sniper_fires')
      // ON CONFLICT on the leg-level unique key, so a retry updates `attempts`
      // in place rather than inserting a second row for the same leg
      // (docs/architecture/sniper-rules.md:143).
      .upsert(fromFire(userId, rec), { onConflict: 'rule_id,trigger_key,wallet_id,leg_no' })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return toFire(data);
  }

  async getFire(userId: string, id: string): Promise<FireRecord | null> {
    const { data, error } = await serviceClient()
      .from('sniper_fires')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toFire(data) : null;
  }

  async fireLog(userId: string, limit = 200): Promise<FireRecord[]> {
    const { data, error } = await serviceClient()
      .from('sniper_fires')
      .select('*')
      .eq('user_id', userId)
      .order('fired_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map(toFire);
  }

  async resolveFire(userId: string, id: string, r: ResolveFireParams): Promise<FireRecord | null> {
    const { data, error } = await serviceClient()
      .from('sniper_fires')
      .update({
        resolution: r.resolution,
        resolved_at: new Date(r.at).toISOString(),
        resolved_note: r.note ?? null,
        // `not_filled` means the operator checked the venue and the send never
        // landed, so the leg stops being indeterminate — it expired.
        ...(r.resolution === 'not_filled' ? { state: 'expired' } : {}),
      })
      .eq('user_id', userId)
      .eq('id', id)
      // The guard rides IN the UPDATE rather than in a preceding SELECT. Under
      // READ COMMITTED a second concurrent UPDATE blocks on the row lock and
      // then re-evaluates this predicate against the committed new version, so
      // it matches zero rows and `maybeSingle()` yields null — the caller skips
      // the release and the day's budget is credited exactly once.
      .eq('state', 'unknown')
      .is('resolution', null)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toFire(data) : null;
  }
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping, all in one block.
//
// Postgres spells "absent" as null and the domain spells it undefined; numerics
// come back as strings on some drivers. Convert at the boundary, once, so no
// caller has to remember either fact.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

function toRule(row: Row): SnipeRule {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    state: row.state as RuleState,
    chain: row.chain as Chain,
    venue: row.venue as Venue,
    handles: (row.handles ?? []) as string[],
    interactionTypes: (row.interaction_types ?? []) as InteractionType[],
    matcher: row.matcher as MatcherNode,
    phase: (row.phase === 2 ? 2 : 1) as 1 | 2,
    mint: row.mint ?? null,
    entryStyle: row.entry_style as EntryStyle,
    ladderSplit: row.ladder_split ? (row.ladder_split as unknown[]).map(num) : null,
    sizeUnit: row.size_unit as SizeUnit,
    sizeTotal: num(row.size_total),
    walletIds: (row.wallet_ids ?? []) as string[],
    perFireCap: num(row.per_fire_cap),
    perTriggerCap: num(row.per_trigger_cap),
    slippageBps: num(row.slippage_bps),
    exec: row.exec_params as ExecParams,
    maxTweetAgeMs: num(row.max_tweet_age_ms),
    fireWindowMs: num(row.fire_window_ms),
    maxAttempts: num(row.max_attempts),
    mcapCeiling: row.mcap_ceiling == null ? null : num(row.mcap_ceiling),
    autoDisableAfterFire: !!row.auto_disable_after_fire,
    dryRun: !!row.dry_run,
  };
}

function fromRule(userId: string, r: SnipeRule): Row {
  return {
    id: r.id,
    user_id: userId,
    name: r.name,
    state: r.state,
    chain: r.chain,
    venue: r.venue,
    handles: r.handles,
    interaction_types: r.interactionTypes,
    matcher: r.matcher,
    phase: r.phase,
    mint: r.mint,
    entry_style: r.entryStyle,
    ladder_split: r.ladderSplit,
    size_unit: r.sizeUnit,
    size_total: r.sizeTotal,
    wallet_ids: r.walletIds,
    per_fire_cap: r.perFireCap,
    per_trigger_cap: r.perTriggerCap,
    slippage_bps: r.slippageBps,
    exec_params: r.exec,
    max_tweet_age_ms: r.maxTweetAgeMs,
    fire_window_ms: r.fireWindowMs,
    max_attempts: r.maxAttempts,
    mcap_ceiling: r.mcapCeiling,
    auto_disable_after_fire: r.autoDisableAfterFire,
    dry_run: r.dryRun,
  };
}

function toWallet(row: Row): WalletConfig {
  return {
    walletId: String(row.id),
    label: String(row.label ?? ''),
    venue: row.venue as Exclude<Venue, 'dryrun'>,
    address: String(row.address),
    chain: row.chain as Chain,
    unit: row.unit as SizeUnit,
    perFireCap: num(row.per_fire_cap),
    dailyCap: num(row.daily_cap),
    maxOpen: num(row.max_open),
  };
}

function fromWallet(userId: string, w: WalletConfig): Row {
  return {
    id: w.walletId,
    user_id: userId,
    label: w.label,
    venue: w.venue,
    address: w.address,
    chain: w.chain,
    unit: w.unit,
    per_fire_cap: w.perFireCap,
    daily_cap: w.dailyCap,
    max_open: w.maxOpen,
  };
}

function toBudget(row: Row): BudgetRow {
  return {
    walletId: String(row.wallet_id),
    chain: row.chain as Chain,
    unit: row.unit as SizeUnit,
    day: String(row.day),
    perFireCap: num(row.per_fire_cap),
    dailyCap: num(row.daily_cap),
    maxOpen: num(row.max_open),
    spentToday: num(row.spent_today),
    openPositions: num(row.open_positions),
  };
}

function toFire(row: Row): FireRecord {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id ?? ''),
    userId: String(row.user_id),
    triggerKey: String(row.trigger_key),
    walletId: String(row.wallet_id ?? ''),
    legNo: num(row.leg_no),
    attempts: num(row.attempts ?? 0),
    mint: String(row.mint),
    amount: num(row.amount),
    state: row.state as FireRecord['state'],
    dryRun: !!row.dry_run,
    venue: row.venue as Venue,
    signature: row.signature ?? undefined,
    abortReason: row.abort_reason ?? undefined,
    resolution: (row.resolution ?? undefined) as FireRecord['resolution'],
    resolvedAt: row.resolved_at ? Date.parse(row.resolved_at) : undefined,
    resolvedNote: row.resolved_note ?? undefined,
    at: row.fired_at ? Date.parse(row.fired_at) : Date.now(),
  };
}

function fromFire(userId: string, rec: Omit<FireRecord, 'id'>): Row {
  return {
    user_id: userId,
    // The inverse of toFire, which reads a NULL wallet_id back as ''. Both
    // columns are nullable FKs (`on delete set null`), and executeFire writes ''
    // for a leg whose wallet did not resolve — passing that through as a literal
    // empty string would fail the uuid cast, and passing the unresolved id would
    // fail the FK. Either way a clean per-leg refusal would become a throw.
    rule_id: rec.ruleId || null,
    wallet_id: rec.walletId || null,
    trigger_key: rec.triggerKey,
    leg_no: rec.legNo,
    attempts: rec.attempts,
    mint: rec.mint,
    amount: rec.amount,
    state: rec.state,
    dry_run: rec.dryRun,
    venue: rec.venue,
    signature: rec.signature ?? null,
    abort_reason: rec.abortReason ?? null,
    fired_at: new Date(rec.at).toISOString(),
  };
}
