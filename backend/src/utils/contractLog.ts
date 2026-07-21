import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mergeEnrichmentPatch } from './enrichmentMerge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const LOG_PATH = join(DATA_DIR, 'contracts.json');
const MAX_ENTRIES = 2000;

export interface ContractEntry {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
  authorId: string;
  authorName: string;
  channelId: string;
  channelName: string;
  guildId: string | null;
  guildName: string | null;
  roomIds: string[];
  messageId: string;
  timestamp: string;
  firstSeen?: boolean;
  // Enrichment (Rick embed / DexScreener)
  tokenName?: string;
  tokenSymbol?: string;
  tokenPair?: string;
  description?: string;
  fdvAtCall?: number;
  fdvAtCallDisplay?: string;
  liquidityUsd?: number;
  liquidityDisplay?: string;
  volumeUsd?: number;
  volumeDisplay?: string;
  priceUsd?: number;
  tokenAge?: string;
  enrichmentSource?: 'rick' | 'dexscreener' | 'gmgn';
  enrichedAt?: string;
}

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

  hasAddress(address: string): boolean {
    return this.entries.some((e) => e.address === address);
  }

  logContract(entry: ContractEntry): void {
    entry.firstSeen = !this.hasAddress(entry.address);
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    this.save();
  }

  getContracts(limit = 100, since?: string): ContractEntry[] {
    let result = this.entries;
    if (since) {
      const cutoff = new Date(since).getTime();
      result = result.filter((e) => new Date(e.timestamp).getTime() > cutoff);
    }
    return result.slice(0, limit);
  }

  deleteContract(messageId: string, address: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => !(e.messageId === messageId && e.address === address),
    );
    if (this.entries.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  updateEvmChain(address: string, evmChain: string): boolean {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.address === address && entry.chain === 'evm' && !entry.evmChain) {
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
