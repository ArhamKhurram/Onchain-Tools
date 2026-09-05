import type { ContractEntry, ContractEnrichmentPatch, EnrichContractOptions } from '../../utils/contractLog.js';
import { mergeEnrichmentPatch } from '../../utils/enrichmentMerge.js';
import { isEvmAddress } from '../../utils/contract.js';
import { BaseRepo, throwIfError } from './client.js';

/**
 * How an address column must be matched, per chain.
 *
 * EVM addresses are case-insensitive hex and stored rows predate
 * canonicalisation (a scanner bot's embed logged a checksummed row, the
 * caller's own post a lowercase one), so they match with `ilike` — Postgres
 * treats a wildcard-free pattern as case-insensitive equality, and hex has no
 * `%`/`_` to expand. Solana mints are base58 and case-SENSITIVE, so folding
 * their case would match a different token; they stay on `eq`.
 */
function addressMatchesInsensitively(address: string): boolean {
  return isEvmAddress(address);
}

/**
 * Migration tolerance for the global-first columns
 * (20260812160000_network_scans.sql, applied BY HAND): until the operator runs
 * it, `first_caller_*`/`first_call_*` don't exist and PostgREST rejects any
 * write naming them. Detect that one failure, warn once, and retry the write
 * without those keys so contract logging/enrichment keeps working unchanged.
 */
const MISSING_FIRST_CALL_COLUMN_RE =
  /(first_call\w*|first_caller\w*).*(does not exist|schema cache)|(does not exist|schema cache).*(first_call\w*|first_caller\w*)/i;

const FIRST_CALL_COLUMNS = ['first_caller_name', 'first_call_mcap_usd', 'first_call_at'] as const;

/**
 * Exactly the columns logContract's repeat-mention carry-forward reads (the
 * `entry.x ?? prior.x` block). `select('*')` here dragged the author/channel/
 * guild strings, room_ids, message_id and ids across the wire on every repeat
 * log — the ingest hot path — and none of them are read (a representative row:
 * 1132B -> 518B). fdv_at_call is deliberately absent: it is per-call, never
 * carried forward.
 */
const PRIOR_COLUMNS =
  'token_name, token_symbol, token_pair, description, liquidity_usd, liquidity_display, volume_usd, volume_display, price_usd, token_age, enrichment_source, enriched_at, evm_chain';
const PRIOR_COLUMNS_WITH_FIRST_CALL = `${PRIOR_COLUMNS}, ${FIRST_CALL_COLUMNS.join(', ')}`;

function stripFirstCallColumns(row: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...row };
  for (const col of FIRST_CALL_COLUMNS) delete rest[col];
  return rest;
}

export class ContractsRepo extends BaseRepo {
  private missingFirstCallColumnsWarned = false;

  /** True (and warns once) when the error means the global-first migration isn't applied. */
  private tolerateMissingFirstCallColumns(error: { message?: string } | null | undefined): boolean {
    if (!error || !MISSING_FIRST_CALL_COLUMN_RE.test(error.message ?? '')) return false;
    if (!this.missingFirstCallColumnsWarned) {
      this.missingFirstCallColumnsWarned = true;
      console.warn(
        '[Supabase] contracts global-first columns are missing — apply migration 20260812160000_network_scans.sql. Global-first enrichment is dropped until then.',
      );
    }
    return true;
  }

  async getContracts(userId: string, limit = 100, since?: string): Promise<ContractEntry[]> {
    let query = this.supabase
      .from('contracts')
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (since) {
      query = query.gt('timestamp', since);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[Supabase] Failed to fetch contracts:', error);
      throw new Error(`Failed to fetch contracts: ${error.message}`);
    }
    if (!data) return [];

    return data.map((row) => this.mapContractRow(row));
  }

  /**
   * Column-scoped read for the caller-scoring board (StorageProvider.getContractsForScoring).
   *
   * The derived-scores path folds up to MAX_CONTRACTS (20k) rows every cache miss.
   * `getContracts`'s `select('*')` drags the message text, `description`, every display
   * string, and the full enrichment block across the wire for each of those rows — the
   * single largest source of Supabase egress in the app. `buildCallerScores` + `getPeaks`
   * read only nine fields (see the field audit); this selects exactly those. The mapper
   * blanks the four required-but-unread fields (channel/guild) — scoring never touches them.
   */
  async getContractsForScoring(userId: string, limit = 100, since?: string): Promise<ContractEntry[]> {
    let query = this.supabase
      .from('contracts')
      .select('address, chain, evm_chain, author_id, author_name, room_ids, message_id, timestamp, fdv_at_call')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (since) {
      query = query.gt('timestamp', since);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[Supabase] Failed to fetch contracts for scoring:', error);
      throw new Error(`Failed to fetch contracts for scoring: ${error.message}`);
    }
    if (!data) return [];

    return data.map((row) => this.mapScoringRow(row));
  }

  /**
   * Resolve one specific logged row by the message it came from.
   *
   * Deliberately not `getContracts(20)` + `.find()`, which is how the two
   * enrichment fallback timers used to locate their target: on a busy feed the
   * row they scheduled themselves for had already scrolled out of that window
   * by the time they fired seconds later, so the fallback quietly did nothing
   * and `fdv_at_call` stayed null. A `(message_id, address)` filter does not
   * care how much has been logged since.
   *
   * `.limit(1)` on a timestamp-descending order because one message can log the
   * same address twice — the same ambiguity `enrichContract` absorbs.
   */
  async getContractByMessage(userId: string, messageId: string, address: string): Promise<ContractEntry | null> {
    const query = this.supabase
      .from('contracts')
      .select('*')
      .eq('user_id', userId)
      .eq('message_id', messageId);

    const { data, error } = await (addressMatchesInsensitively(address)
      ? query.ilike('address', address)
      : query.eq('address', address))
      .order('timestamp', { ascending: false })
      .limit(1);

    // Surface a query failure rather than swallow it as row-not-found — the
    // window scan this replaced threw, which showed up as a "Dex fallback
    // failed" log. A silent skip would hide a broken fallback as a missing FDV.
    throwIfError({ error }, 'Failed to look up contract by message');
    return data?.[0] ? this.mapContractRow(data[0]) : null;
  }

  async logContract(userId: string, entry: ContractEntry): Promise<ContractEntry> {
    const isFirstSeen = !(await this.hasAddress(userId, entry.address));
    let toInsert = entry;

    if (!isFirstSeen) {
      const priorQuery = (columns: string) =>
        this.supabase
          .from('contracts')
          .select(columns)
          .eq('user_id', userId)
          .ilike('address', entry.address)
          .or('token_symbol.not.is.null,token_name.not.is.null')
          .order('timestamp', { ascending: false })
          .limit(1);

      // Same pre-migration tolerance as the insert below: a SELECT naming the
      // global-first columns fails on a database that hasn't applied
      // 20260812160000_network_scans.sql, so retry without them.
      let { data: priorRows, error: priorError } = await priorQuery(PRIOR_COLUMNS_WITH_FIRST_CALL);
      if (priorError && this.tolerateMissingFirstCallColumns(priorError)) {
        ({ data: priorRows } = await priorQuery(PRIOR_COLUMNS));
      }

      const prior = priorRows?.[0] ? this.mapPriorRow(priorRows[0]) : null;
      if (prior) {
        toInsert = {
          ...entry,
          tokenName: entry.tokenName ?? prior.tokenName,
          tokenSymbol: entry.tokenSymbol ?? prior.tokenSymbol,
          tokenPair: entry.tokenPair ?? prior.tokenPair,
          description: entry.description ?? prior.description,
          liquidityUsd: entry.liquidityUsd ?? prior.liquidityUsd,
          liquidityDisplay: entry.liquidityDisplay ?? prior.liquidityDisplay,
          volumeUsd: entry.volumeUsd ?? prior.volumeUsd,
          volumeDisplay: entry.volumeDisplay ?? prior.volumeDisplay,
          priceUsd: entry.priceUsd ?? prior.priceUsd,
          tokenAge: entry.tokenAge ?? prior.tokenAge,
          enrichmentSource: entry.enrichmentSource ?? prior.enrichmentSource,
          enrichedAt: entry.enrichedAt ?? prior.enrichedAt,
          evmChain: entry.evmChain ?? prior.evmChain,
          // Global-first is token-level, not per-call, so carrying it forward
          // onto a repeat mention is correct (unlike fdvAtCall, which is not).
          firstCallerName: entry.firstCallerName ?? prior.firstCallerName,
          firstCallMcapUsd: entry.firstCallMcapUsd ?? prior.firstCallMcapUsd,
          firstCallAt: entry.firstCallAt ?? prior.firstCallAt,
        };
      }
    }

    const insertRow: Record<string, unknown> = {
      user_id: userId,
      address: toInsert.address,
      chain: toInsert.chain,
      evm_chain: toInsert.evmChain ?? null,
      author_id: toInsert.authorId,
      author_name: toInsert.authorName,
      channel_id: toInsert.channelId,
      channel_name: toInsert.channelName,
      guild_id: toInsert.guildId,
      guild_name: toInsert.guildName,
      room_ids: toInsert.roomIds,
      message_id: toInsert.messageId,
      timestamp: toInsert.timestamp,
      first_seen: isFirstSeen,
      token_name: toInsert.tokenName ?? null,
      token_symbol: toInsert.tokenSymbol ?? null,
      token_pair: toInsert.tokenPair ?? null,
      description: toInsert.description ?? null,
      fdv_at_call: toInsert.fdvAtCall ?? null,
      fdv_at_call_display: toInsert.fdvAtCallDisplay ?? null,
      liquidity_usd: toInsert.liquidityUsd ?? null,
      liquidity_display: toInsert.liquidityDisplay ?? null,
      volume_usd: toInsert.volumeUsd ?? null,
      volume_display: toInsert.volumeDisplay ?? null,
      price_usd: toInsert.priceUsd ?? null,
      token_age: toInsert.tokenAge ?? null,
      enrichment_source: toInsert.enrichmentSource ?? null,
      enriched_at: toInsert.enrichedAt ?? null,
    };
    // Name the global-first columns only when there is data for them, so rows
    // without it never trip the pre-migration column check.
    if (toInsert.firstCallerName != null) insertRow.first_caller_name = toInsert.firstCallerName;
    if (toInsert.firstCallMcapUsd != null) insertRow.first_call_mcap_usd = toInsert.firstCallMcapUsd;
    if (toInsert.firstCallAt != null) insertRow.first_call_at = toInsert.firstCallAt;

    let result = await this.supabase.from('contracts').insert(insertRow);
    if (result.error && this.tolerateMissingFirstCallColumns(result.error)) {
      result = await this.supabase.from('contracts').insert(stripFirstCallColumns(insertRow));
    }
    throwIfError(result, 'Failed to log contract');
    return { ...toInsert, firstSeen: isFirstSeen };
  }

  async deleteContract(userId: string, messageId: string, address: string): Promise<boolean> {
    const query = this.supabase
      .from('contracts')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .eq('message_id', messageId);

    const { count } = await (addressMatchesInsensitively(address)
      ? query.ilike('address', address)
      : query.eq('address', address));

    return (count ?? 0) > 0;
  }

  async deleteAllContracts(userId: string): Promise<void> {
    await this.supabase.from('contracts').delete().eq('user_id', userId);
  }

  async updateEvmChain(userId: string, address: string, evmChain: string): Promise<boolean> {
    const base = this.supabase
      .from('contracts')
      .update({ evm_chain: evmChain })
      .eq('user_id', userId);

    const { data } = await (addressMatchesInsensitively(address)
      ? base.ilike('address', address)
      : base.eq('address', address))
      .eq('chain', 'evm')
      .is('evm_chain', null)
      .select('id');

    return (data?.length ?? 0) > 0;
  }

  async enrichContract(
    userId: string,
    address: string,
    patch: ContractEnrichmentPatch,
    options?: EnrichContractOptions,
  ): Promise<ContractEntry | null> {
    const channelId = options?.channelId;
    const messageId = options?.messageId;

    let row: Record<string, unknown> | undefined;

    if (messageId) {
      const { data } = await this.supabase
        .from('contracts')
        .select('*')
        .eq('user_id', userId)
        .eq('message_id', messageId)
        .ilike('address', address)
        .limit(1);
      row = data?.[0];
    }

    if (!row) {
      let query = this.supabase
        .from('contracts')
        .select('*')
        .eq('user_id', userId)
        .ilike('address', address)
        .order('timestamp', { ascending: false })
        .limit(1);

      if (channelId) {
        query = query.eq('channel_id', channelId);
      }

      let { data: rows } = await query;
      if ((!rows || rows.length === 0) && channelId) {
        const fallback = await this.supabase
          .from('contracts')
          .select('*')
          .eq('user_id', userId)
          .ilike('address', address)
          .order('timestamp', { ascending: false })
          .limit(1);
        rows = fallback.data;
      }
      row = rows?.[0];
    }

    if (!row) return null;

    const existing = this.mapContractRow(row);
    const merged = mergeEnrichmentPatch(
      {
        tokenName: existing.tokenName,
        tokenSymbol: existing.tokenSymbol,
        tokenPair: existing.tokenPair,
        evmChain: existing.evmChain,
        enrichmentSource: existing.enrichmentSource,
        enrichedAt: existing.enrichedAt,
        fdvAtCall: existing.fdvAtCall,
        fdvAtCallDisplay: existing.fdvAtCallDisplay,
        firstCallerName: existing.firstCallerName,
        firstCallMcapUsd: existing.firstCallMcapUsd,
        firstCallAt: existing.firstCallAt,
      },
      patch,
    );

    const update: Record<string, unknown> = {
      enriched_at: merged.enrichedAt ?? new Date().toISOString(),
    };
    if (merged.tokenName !== undefined) update.token_name = merged.tokenName;
    if (merged.tokenSymbol !== undefined) update.token_symbol = merged.tokenSymbol;
    if (merged.tokenPair !== undefined) update.token_pair = merged.tokenPair;
    if (merged.description !== undefined) update.description = merged.description;
    if (merged.fdvAtCall !== undefined) update.fdv_at_call = merged.fdvAtCall;
    if (merged.fdvAtCallDisplay !== undefined) update.fdv_at_call_display = merged.fdvAtCallDisplay;
    if (merged.liquidityUsd !== undefined) update.liquidity_usd = merged.liquidityUsd;
    if (merged.liquidityDisplay !== undefined) update.liquidity_display = merged.liquidityDisplay;
    if (merged.volumeUsd !== undefined) update.volume_usd = merged.volumeUsd;
    if (merged.volumeDisplay !== undefined) update.volume_display = merged.volumeDisplay;
    if (merged.priceUsd !== undefined) update.price_usd = merged.priceUsd;
    if (merged.tokenAge !== undefined) update.token_age = merged.tokenAge;
    if (merged.enrichmentSource !== undefined) update.enrichment_source = merged.enrichmentSource;
    if (merged.evmChain !== undefined && !row.evm_chain) update.evm_chain = merged.evmChain;
    if (merged.firstCallerName !== undefined) update.first_caller_name = merged.firstCallerName;
    if (merged.firstCallMcapUsd !== undefined) update.first_call_mcap_usd = merged.firstCallMcapUsd;
    if (merged.firstCallAt !== undefined) update.first_call_at = merged.firstCallAt;

    if (Object.keys(update).length <= 1 && !merged.tokenName && !merged.tokenSymbol && !merged.tokenPair && !merged.evmChain) {
      return existing;
    }

    // Update BY PRIMARY KEY. The row was already resolved above, so re-deriving
    // it from (user_id, message_id, address) only reintroduces ambiguity the
    // lookup deliberately resolved with `.limit(1)`.
    //
    // That mismatch broke enrichment outright in production: `.single()` raises
    // PGRST116 ("Cannot coerce the result to a single JSON object") unless
    // exactly one row matches, and `(user_id, message_id, address)` is not
    // unique. `ilike` is case-INSENSITIVE, so one message that logs the same
    // address twice — or twice in different casing, which is routine for EVM
    // where checksummed and lowercased forms are the same address — matches
    // both rows. The lookup above absorbs that with `.limit(1)`; this update
    // did not, and threw instead.
    //
    // Every enrichment write failed, from both the Rick embed path and the Dex
    // fallback, which is why MC@CALL was empty across the radar while MC-now
    // (read live, never stored) kept working.
    //
    // `id` is the primary key, so exactly one row matches or none does.
    // `user_id` stays as defence in depth alongside RLS. `maybeSingle` because
    // a row deleted between lookup and update is a null, not an exception.
    let { data: updated, error } = await this.supabase
      .from('contracts')
      .update(update)
      .eq('id', row.id as string)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();

    if (error && this.tolerateMissingFirstCallColumns(error)) {
      const retry = await this.supabase
        .from('contracts')
        .update(stripFirstCallColumns(update))
        .eq('id', row.id as string)
        .eq('user_id', userId)
        .select('*')
        .maybeSingle();
      updated = retry.data;
      error = retry.error;
    }

    throwIfError({ error }, 'Failed to enrich contract');
    return updated ? this.mapContractRow(updated) : null;
  }

  /**
   * Maps a column-scoped scoring row. Only the nine selected columns are real; the four
   * required ContractEntry fields the scorer never reads (channelId/channelName/guildId/
   * guildName) are blanked so the partial row still satisfies the type. If a future scorer
   * starts reading one of these, widen the `select` in getContractsForScoring first.
   */
  private mapScoringRow(row: any): ContractEntry {
    return {
      address: row.address,
      chain: row.chain as 'evm' | 'sol',
      evmChain: row.evm_chain ?? undefined,
      authorId: row.author_id,
      authorName: row.author_name,
      channelId: '',
      channelName: '',
      guildId: null,
      guildName: null,
      roomIds: row.room_ids ?? [],
      messageId: row.message_id,
      timestamp: row.timestamp,
      fdvAtCall: row.fdv_at_call != null ? Number(row.fdv_at_call) : undefined,
    };
  }

  /**
   * Maps a PRIOR_COLUMNS row — only the enrichment fields the repeat-mention
   * carry-forward in logContract reads. If that block starts reading a new
   * field, add its column to PRIOR_COLUMNS first.
   */
  private mapPriorRow(row: any): Pick<
    ContractEntry,
    | 'tokenName' | 'tokenSymbol' | 'tokenPair' | 'description'
    | 'liquidityUsd' | 'liquidityDisplay' | 'volumeUsd' | 'volumeDisplay'
    | 'priceUsd' | 'tokenAge' | 'enrichmentSource' | 'enrichedAt' | 'evmChain'
    | 'firstCallerName' | 'firstCallMcapUsd' | 'firstCallAt'
  > {
    return {
      tokenName: row.token_name ?? undefined,
      tokenSymbol: row.token_symbol ?? undefined,
      tokenPair: row.token_pair ?? undefined,
      description: row.description ?? undefined,
      liquidityUsd: row.liquidity_usd != null ? Number(row.liquidity_usd) : undefined,
      liquidityDisplay: row.liquidity_display ?? undefined,
      volumeUsd: row.volume_usd != null ? Number(row.volume_usd) : undefined,
      volumeDisplay: row.volume_display ?? undefined,
      priceUsd: row.price_usd != null ? Number(row.price_usd) : undefined,
      tokenAge: row.token_age ?? undefined,
      enrichmentSource: row.enrichment_source ?? undefined,
      enrichedAt: row.enriched_at ?? undefined,
      evmChain: row.evm_chain ?? undefined,
      firstCallerName: row.first_caller_name ?? undefined,
      firstCallMcapUsd: row.first_call_mcap_usd != null ? Number(row.first_call_mcap_usd) : undefined,
      firstCallAt: row.first_call_at ?? undefined,
    };
  }

  private mapContractRow(row: any): ContractEntry {
    return {
      address: row.address,
      chain: row.chain as 'evm' | 'sol',
      evmChain: row.evm_chain ?? undefined,
      authorId: row.author_id,
      authorName: row.author_name,
      channelId: row.channel_id,
      channelName: row.channel_name,
      guildId: row.guild_id,
      guildName: row.guild_name,
      roomIds: row.room_ids ?? [],
      messageId: row.message_id,
      timestamp: row.timestamp,
      firstSeen: row.first_seen ?? undefined,
      tokenName: row.token_name ?? undefined,
      tokenSymbol: row.token_symbol ?? undefined,
      tokenPair: row.token_pair ?? undefined,
      description: row.description ?? undefined,
      fdvAtCall: row.fdv_at_call != null ? Number(row.fdv_at_call) : undefined,
      fdvAtCallDisplay: row.fdv_at_call_display ?? undefined,
      liquidityUsd: row.liquidity_usd != null ? Number(row.liquidity_usd) : undefined,
      liquidityDisplay: row.liquidity_display ?? undefined,
      volumeUsd: row.volume_usd != null ? Number(row.volume_usd) : undefined,
      volumeDisplay: row.volume_display ?? undefined,
      priceUsd: row.price_usd != null ? Number(row.price_usd) : undefined,
      tokenAge: row.token_age ?? undefined,
      enrichmentSource: row.enrichment_source ?? undefined,
      enrichedAt: row.enriched_at ?? undefined,
      firstCallerName: row.first_caller_name ?? undefined,
      firstCallMcapUsd: row.first_call_mcap_usd != null ? Number(row.first_call_mcap_usd) : undefined,
      firstCallAt: row.first_call_at ?? undefined,
    };
  }

  async hasAddress(userId: string, address: string): Promise<boolean> {
    const query = this.supabase
      .from('contracts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count } = await (addressMatchesInsensitively(address)
      ? query.ilike('address', address)
      : query.eq('address', address));

    return (count ?? 0) > 0;
  }
}
