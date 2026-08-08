import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mergeEnrichmentPatch } from './enrichmentMerge.js';
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

  logContract(entry: ContractEntry): ContractEntry {
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
  getContractByMessage(messageId: string, address: string): ContractEntry | null {
    const key = normalizeContractAddress(address);
    return (
      this.entries.find(
        (e) => e.messageId === messageId && normalizeContractAddress(e.address) === key,
      ) ?? null
    );
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

    if (messageId) {
      for (const entry of this.entries) {
        if (entry.address.toLowerCase() !== key) continue;
        if (entry.messageId !== messageId) continue;
        best = entry;
        break;
      }
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

    const merged = mergeEnrichmentPatch(
      {
        tokenName: best.tokenName,
        tokenSymbol: best.tokenSymbol,
        tokenPair: best.tokenPair,
        evmChain: best.evmChain,
        enrichmentSource: best.enrichmentSource,
        enrichedAt: best.enrichedAt,
        fdvAtCall: best.fdvAtCall,
        fdvAtCallDisplay: best.fdvAtCallDisplay,
      },
      patch,
    );

    Object.assign(best, merged, { enrichedAt: merged.enrichedAt ?? new Date().toISOString() });
    this.save();
    return best;
  }

  deleteAllContracts(): void {
    this.entries = [];
    this.save();
  }
}

export const contractLog = new ContractLog();
