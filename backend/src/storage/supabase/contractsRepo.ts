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

export class ContractsRepo extends BaseRepo {
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

  async logContract(userId: string, entry: ContractEntry): Promise<ContractEntry> {
    const isFirstSeen = !(await this.hasAddress(userId, entry.address));
    let toInsert = entry;

    if (!isFirstSeen) {
      const { data: priorRows } = await this.supabase
        .from('contracts')
        .select('*')
        .eq('user_id', userId)
        .ilike('address', entry.address)
        .or('token_symbol.not.is.null,token_name.not.is.null')
        .order('timestamp', { ascending: false })
        .limit(1);

      const prior = priorRows?.[0] ? this.mapContractRow(priorRows[0]) : null;
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
        };
      }
    }

    const result = await this.supabase.from('contracts').insert({
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
    });
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
    const { data: updated, error } = await this.supabase
      .from('contracts')
      .update(update)
      .eq('id', row.id as string)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();

    throwIfError({ error }, 'Failed to enrich contract');
    return updated ? this.mapContractRow(updated) : null;
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
      fdvAtCallProvenance: row.fdv_at_call_provenance ?? undefined,
      liquidityUsd: row.liquidity_usd != null ? Number(row.liquidity_usd) : undefined,
      liquidityDisplay: row.liquidity_display ?? undefined,
      volumeUsd: row.volume_usd != null ? Number(row.volume_usd) : undefined,
      volumeDisplay: row.volume_display ?? undefined,
      priceUsd: row.price_usd != null ? Number(row.price_usd) : undefined,
      tokenAge: row.token_age ?? undefined,
      enrichmentSource: row.enrichment_source ?? undefined,
      enrichedAt: row.enriched_at ?? undefined,
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
