import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mergeEnrichmentPatch, needsMetadataFallback } from './enrichmentMerge.js';
import { normalizeContractAddress } from '@oct/shared';
import type { ContractEntry } from '@oct/shared';

// ContractEntry is now canonical in @oct/shared; re-export it so existing
// `../utils/contractLog.js` importers keep working.
export type { ContractEntry } from '@oct/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const LOG_PATH = join(DATA_DIR, 'contracts.json');
/**
 * Local-mode retention. Rows past this are dropped, permanently — the whole
 * array is rewritten on every log, so this is a deliberate ceiling on file size
 * and write cost, not an oversight.
 *
 * It is also the real retention limit for caller scores in local mode: scores
 * are derived on read from this log, so a caller whose rows have rolled off has
 * no history left to score. On a busy feed 2000 rows can be a couple of days,
 * well short of the 30-day scoring window. Raise it via
 * `OCT_CONTRACT_LOG_MAX` if you want a longer leaderboard and can afford the
 * larger rewrite per contract. (Hosted mode keeps everything in Postgres and is
 * unaffected.)
 */
const MAX_ENTRIES =
  Number.parseInt(process.env.OCT_CONTRACT_LOG_MAX ?? process.env.TRENCHCORD_CONTRACT_LOG_MAX ?? '', 10) ||
  2000;

export type ContractEnrichmentPatch = Partial<
  Pick<
    ContractEntry,
    | 'tokenName'
    | 'tokenSymbol'
    | 'tokenPair'
    | 'description'
    | 'fdvAtCall'
    | 'fdvAtCallDisplay'
    | 'liquidityUsd'
    | 'liquidityDisplay'
    | 'volumeUsd'
    | 'volumeDisplay'
    | 'priceUsd'
    | 'tokenAge'
    | 'evmChain'
    | 'enrichmentSource'
    | 'enrichedAt'
    | 'firstCallerName'
    | 'firstCallMcapUsd'
    | 'firstCallAt'
  >
>;

export interface EnrichContractOptions {
  channelId?: string;
  messageId?: string;
}

class ContractLog {
  private entries: ContractEntry[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(LOG_PATH)) {
        this.entries = JSON.parse(readFileSync(LOG_PATH, 'utf-8'));
      }
    } catch (err) {
      console.error('[ContractLog] Failed to load:', err);
      this.entries = [];
    }
  }

  private save(): void {
    try {
      writeFileSync(LOG_PATH, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ContractLog] Failed to save:', err);
    }
  }

  // Rows written before addresses were canonicalised keep their original
  // casing, so every lookup compares normalised forms rather than raw strings.
  // (Chain-aware: a no-op for case-sensitive base58 Solana mints.)
  hasAddress(address: string): boolean {
    const key = normalizeContractAddress(address);
    return this.entries.some((e) => normalizeContractAddress(e.address) === key);
  }

  /**
   * The entry this exact call already produced, or null.
   *
   * `(messageId, address)` identifies one call — one ingested message
   * mentioning one address. Telegram message ids are `tg_<chatId>_<id>`, so the
   * pair is unambiguous across chats without a user dimension (local mode is
   * single-user by construction).
   *
   * Bounded by MAX_ENTRIES like every other read here: a re-delivery arriving
   * after the original has rolled off the retained log is logged again. On a
   * 2000-row local log that is hours of feed, far past the measured duplicate
   * tail (max ~2.9h, p99 ~2.1h in production), and the alternative — a
   * side index that outlives the log it guards — is not worth the drift.
   */
  private findLoggedCall(messageId: string, address: string): ContractEntry | null {
    const key = normalizeContractAddress(address);
    return (
      this.entries.find(
        (e) => e.messageId === messageId && normalizeContractAddress(e.address) === key,
      ) ?? null
    );
  }

  logContract(entry: ContractEntry): ContractEntry {
    // One call = one entry. The hosted path carries the full explanation (see
    // ContractsRepo.logContract): the Telegram update stream re-delivers a
    // message after a reconnect or an update-gap recovery, minutes to hours
    // later, and an unconditional append turned one call into up to 16 rows —
    // inflating the call counts the caller/radar bands are computed over.
    const existing = this.findLoggedCall(entry.messageId, entry.address);
    // Returned as a COPY flagged `duplicate`, never the stored object itself:
    // the flag is a transport hint for the console (drop the re-delivery
    // instead of rendering a second feed row) and must not leak into the
    // persisted log or into what a later read hands back.
    if (existing) return { ...existing, duplicate: true };

    entry.firstSeen = !this.hasAddress(entry.address);
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    this.save();
    return entry;
  }

  getContracts(limit = 100, since?: string): ContractEntry[] {
    let result = this.entries;
    if (since) {
      const cutoff = new Date(since).getTime();
      result = result.filter((e) => new Date(e.timestamp).getTime() > cutoff);
    }
    return result.slice(0, limit);
  }

  // Entries are unshifted, so the first match is the newest — which is the one
  // a caller holding a (messageId, address) pair means, on the rare message
  // that logs the same address twice.
  /**
   * The row a fallback timer scheduled itself for. When one message logged the
   * same address more than once, the one still missing a symbol or an MC@call
   * wins — `enrichContract` fans its write across the whole group, so returning
   * a still-blank member is what gets every member filled. See the matching
   * note in storage/supabase/contractsRepo.ts.
   */
  getContractByMessage(messageId: string, address: string): ContractEntry | null {
    const key = normalizeContractAddress(address);
    const matches = this.entries.filter(
      (e) => e.messageId === messageId && normalizeContractAddress(e.address) === key,
    );
    if (matches.length === 0) return null;
    return matches.find((e) => needsMetadataFallback(e)) ?? matches[0];
  }

  deleteContract(messageId: string, address: string): boolean {
    const before = this.entries.length;
    const key = normalizeContractAddress(address);
    this.entries = this.entries.filter(
      (e) => !(e.messageId === messageId && normalizeContractAddress(e.address) === key),
    );
    if (this.entries.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  updateEvmChain(address: string, evmChain: string): boolean {
    let changed = false;
    const key = normalizeContractAddress(address);
    for (const entry of this.entries) {
      if (normalizeContractAddress(entry.address) === key && entry.chain === 'evm' && !entry.evmChain) {
        entry.evmChain = evmChain;
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  enrichContract(
    address: string,
    patch: ContractEnrichmentPatch,
    options?: EnrichContractOptions,
  ): ContractEntry | null {
    const channelId = options?.channelId;
    const messageId = options?.messageId;
    const key = address.toLowerCase();
    let best: ContractEntry | null = null;
    // Every entry (messageId, address) matches. One ingested message can be
    // logged more than once — `logContract` always appends — and all of those
    // entries describe the same call, so the enrichment has to reach all of
    // them, not just the first one found. See the fan-out note in
    // storage/supabase/contractsRepo.ts.
    const siblings: ContractEntry[] = [];

    if (messageId) {
      for (const entry of this.entries) {
        if (entry.address.toLowerCase() !== key) continue;
        if (entry.messageId !== messageId) continue;
        siblings.push(entry);
      }
      best = siblings[0] ?? null;
    }

    if (!best) {
      for (const entry of this.entries) {
        if (entry.address.toLowerCase() !== key) continue;
        if (channelId && entry.channelId !== channelId) continue;
        if (!best || new Date(entry.timestamp).getTime() > new Date(best.timestamp).getTime()) {
          best = entry;
        }
      }
    }

    if (!best && channelId) {
      for (const entry of this.entries) {
        if (entry.address.toLowerCase() !== key) continue;
        if (!best || new Date(entry.timestamp).getTime() > new Date(best.timestamp).getTime()) {
          best = entry;
        }
      }
    }

    if (!best) return null;

    // `best` is always the first sibling when the message-scoped lookup found
    // any, so the loop covers it; the channel/address guesses below produce no
    // siblings and fall back to enriching `best` alone.
    for (const entry of siblings.length > 0 ? siblings : [best]) {
      const merged = mergeEnrichmentPatch(
        {
          tokenName: entry.tokenName,
          tokenSymbol: entry.tokenSymbol,
          tokenPair: entry.tokenPair,
          evmChain: entry.evmChain,
          enrichmentSource: entry.enrichmentSource,
          enrichedAt: entry.enrichedAt,
          fdvAtCall: entry.fdvAtCall,
          fdvAtCallDisplay: entry.fdvAtCallDisplay,
          firstCallerName: entry.firstCallerName,
          firstCallMcapUsd: entry.firstCallMcapUsd,
          firstCallAt: entry.firstCallAt,
        },
        patch,
      );
      Object.assign(entry, merged, { enrichedAt: merged.enrichedAt ?? new Date().toISOString() });
    }
    this.save();
    return best;
  }

  deleteAllContracts(): void {
    this.entries = [];
    this.save();
  }
}

export const contractLog = new ContractLog();
