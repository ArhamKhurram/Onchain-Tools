/**
 * JSON file-backed journal store for local (single-user) mode — the sibling of
 * ContractLog/RevivalAlertLog. One file (`journal.json`) holds wallets, trades
 * and positions; the whole document is rewritten on every save, same tradeoff
 * as the other local stores.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { JournalPosition, JournalTrade, JournalWallet } from '@oct/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const LOG_PATH = join(DATA_DIR, 'journal.json');

/**
 * Local-mode retention. An active memecoin trader produces a few thousand
 * swaps in months; 20k rows is years of history and still loads instantly.
 */
const MAX_TRADES = 20_000;
const MAX_POSITIONS = 5_000;

interface JournalDocument {
  wallets: JournalWallet[];
  trades: JournalTrade[];
  positions: JournalPosition[];
}

class JournalLog {
  private doc: JournalDocument = { wallets: [], trades: [], positions: [] };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(LOG_PATH)) {
        const parsed = JSON.parse(readFileSync(LOG_PATH, 'utf-8')) as Partial<JournalDocument>;
        this.doc = {
          wallets: Array.isArray(parsed.wallets) ? parsed.wallets : [],
          trades: Array.isArray(parsed.trades) ? parsed.trades : [],
          // closeReason landed after v1: normalize legacy rows to null rather
          // than relabelling their closes as 'sold'.
          positions: Array.isArray(parsed.positions)
            ? parsed.positions.map((p) => ({ ...p, closeReason: p.closeReason ?? null }))
            : [],
        };
      }
    } catch (err) {
      console.error('[JournalLog] Failed to load:', err);
      this.doc = { wallets: [], trades: [], positions: [] };
    }
  }

  private save(): void {
    try {
      writeFileSync(LOG_PATH, JSON.stringify(this.doc, null, 2), 'utf-8');
    } catch (err) {
      console.error('[JournalLog] Failed to save:', err);
    }
  }

  // ---- Wallets ----

  listWallets(): JournalWallet[] {
    return [...this.doc.wallets];
  }

  addWallet(address: string, label: string | null): JournalWallet {
    const existing = this.doc.wallets.find((w) => w.address === address);
    if (existing) return existing;
    const wallet: JournalWallet = {
      id: randomUUID(),
      address,
      label,
      chain: 'solana',
      lastSignature: null,
      lastPolledAt: null,
      createdAt: new Date().toISOString(),
    };
    this.doc.wallets.push(wallet);
    this.save();
    return wallet;
  }

  removeWallet(walletId: string): boolean {
    const before = this.doc.wallets.length;
    this.doc.wallets = this.doc.wallets.filter((w) => w.id !== walletId);
    if (this.doc.wallets.length === before) return false;
    this.doc.trades = this.doc.trades.filter((t) => t.walletId !== walletId);
    this.doc.positions = this.doc.positions.filter((p) => p.walletId !== walletId);
    this.save();
    return true;
  }

  updateWalletCursor(walletId: string, lastSignature: string | null, lastPolledAt: string): boolean {
    const wallet = this.doc.wallets.find((w) => w.id === walletId);
    if (!wallet) return false;
    wallet.lastSignature = lastSignature;
    wallet.lastPolledAt = lastPolledAt;
    this.save();
    return true;
  }

  // ---- Trades ----

  /** Insert trades, idempotent on (walletId, txSignature, mint, side). */
  addTrades(trades: JournalTrade[]): number {
    if (trades.length === 0) return 0;
    const seen = new Set(
      this.doc.trades.map((t) => `${t.walletId}|${t.txSignature}|${t.mint}|${t.side}`),
    );
    let added = 0;
    for (const t of trades) {
      const key = `${t.walletId}|${t.txSignature}|${t.mint}|${t.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.doc.trades.push(t);
      added += 1;
    }
    if (added > 0) {
      this.doc.trades.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      if (this.doc.trades.length > MAX_TRADES) {
        this.doc.trades = this.doc.trades.slice(this.doc.trades.length - MAX_TRADES);
      }
      this.save();
    }
    return added;
  }

  listTrades(limit?: number, walletId?: string): JournalTrade[] {
    let rows = walletId
      ? this.doc.trades.filter((t) => t.walletId === walletId)
      : [...this.doc.trades];
    // Newest first for the API surface.
    rows = rows.slice().reverse();
    return limit != null ? rows.slice(0, limit) : rows;
  }

  // ---- Positions ----

  /** Replace a wallet's positions wholesale (the pairing engine rebuilds them). */
  replacePositionsForWallet(walletId: string, positions: JournalPosition[]): void {
    const preserved = new Map(
      this.doc.positions
        .filter((p) => p.walletId === walletId && p.lastPriceUsd != null)
        .map((p) => [p.id, { lastPriceUsd: p.lastPriceUsd, lastPriceAt: p.lastPriceAt }]),
    );
    const rest = this.doc.positions.filter((p) => p.walletId !== walletId);
    const next = positions.map((p) => {
      const price = preserved.get(p.id);
      return price ? { ...p, ...price } : p;
    });
    this.doc.positions = [...rest, ...next].slice(-MAX_POSITIONS);
    this.save();
  }

  listPositions(status?: 'open' | 'closed'): JournalPosition[] {
    const rows = status
      ? this.doc.positions.filter((p) => p.status === status)
      : [...this.doc.positions];
    return rows.sort((a, b) => new Date(b.lastTradeAt).getTime() - new Date(a.lastTradeAt).getTime());
  }

  updatePositionPrice(positionId: string, priceUsd: number, at: string): void {
    const pos = this.doc.positions.find((p) => p.id === positionId);
    if (!pos) return;
    pos.lastPriceUsd = priceUsd;
    pos.lastPriceAt = at;
    this.save();
  }
}

export const journalLog = new JournalLog();
