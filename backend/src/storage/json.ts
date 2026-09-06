import { configStore } from '../config/store.js';
import { contractLog } from '../utils/contractLog.js';
import { revivalAlertLog } from '../utils/revivalAlertLog.js';
import { journalLog } from '../journal/journalLog.js';
import { priceAlertLog } from '../priceAlerts/priceAlertLog.js';
import { pumpSessionStore } from '../pumpfun/pumpSessionStore.js';
import { sanitizeStoredFilters, type McapCrossFilters } from '../mcapCross/filters.js';
import type {
  PriceAlertInput,
  PriceAlertObservationPatch,
  PumpSession,
  StorageProvider,
} from './interface.js';
import type { AppConfig, Room } from '../discord/types.js';
import type { ContractEntry, ContractEnrichmentPatch, EnrichContractOptions } from '../utils/contractLog.js';
import type {
  JournalPosition,
  JournalTrade,
  JournalWallet,
  PriceAlert,
  PriceAlertStatus,
  RevivalAlertEntry,
  RevivalOutcomePatch,
} from '@oct/shared';

/**
 * JSON file-backed storage provider for local (single-user) mode.
 * Delegates to the existing ConfigStore and ContractLog singletons.
 * The userId parameter is ignored since there is only one user.
 */
export class JsonStorageProvider implements StorageProvider {
  async getConfig(_userId: string): Promise<AppConfig> {
    return configStore.getConfig();
  }

  async updateConfig(_userId: string, partial: Partial<AppConfig>): Promise<AppConfig> {
    return configStore.updateConfig(partial as any);
  }

  async getTokens(_userId: string): Promise<string[]> {
    return configStore.getTokens();
  }

  async setTokens(_userId: string, tokens: string[]): Promise<void> {
    configStore.setTokens(tokens);
  }

  // The pump.fun bearer is kept in its own plaintext store (pumpSessionStore),
  // isolated from AppConfig so it can never leak through a config route/export.
  async getPumpSession(_userId: string): Promise<PumpSession | null> {
    return pumpSessionStore.getSession();
  }

  async setPumpSession(_userId: string, token: string | null): Promise<void> {
    pumpSessionStore.setSession(token);
  }

  async getRooms(_userId: string): Promise<Room[]> {
    return configStore.getRooms();
  }

  async getRoom(_userId: string, roomId: string): Promise<Room | null> {
    return configStore.getRoom(roomId) ?? null;
  }

  async createRoom(_userId: string, data: Omit<Room, 'id'>): Promise<Room> {
    return configStore.createRoom(data);
  }

  async updateRoom(_userId: string, roomId: string, data: Partial<Room>): Promise<Room | null> {
    return configStore.updateRoom(roomId, data);
  }

  async deleteRoom(_userId: string, roomId: string): Promise<boolean> {
    return configStore.deleteRoom(roomId);
  }

  async getRoomsForChannel(_userId: string, channelId: string): Promise<Room[]> {
    return configStore.getRoomsForChannel(channelId);
  }

  async isChannelSubscribed(_userId: string, channelId: string): Promise<boolean> {
    return configStore.isChannelSubscribed(channelId);
  }

  async isUserHighlighted(_userId: string, discordUserId: string, roomId?: string, username?: string | null): Promise<boolean> {
    return configStore.isUserHighlighted(discordUserId, roomId, username);
  }

  async getContracts(_userId: string, limit?: number, since?: string): Promise<ContractEntry[]> {
    return contractLog.getContracts(limit, since);
  }

  /**
   * Local storage is JSON files on disk — reading every column costs nothing over the
   * wire, so the slim scoring read is just the full read. The column-scoping only
   * matters on the hosted (Supabase) path, where it is the actual egress fix.
   */
  async getContractsForScoring(userId: string, limit?: number, since?: string): Promise<ContractEntry[]> {
    return this.getContracts(userId, limit, since);
  }

  async getContractByMessage(_userId: string, messageId: string, address: string): Promise<ContractEntry | null> {
    return contractLog.getContractByMessage(messageId, address);
  }

  async logContract(_userId: string, entry: ContractEntry): Promise<ContractEntry> {
    return contractLog.logContract(entry);
  }

  async deleteContract(_userId: string, messageId: string, address: string): Promise<boolean> {
    return contractLog.deleteContract(messageId, address);
  }

  async deleteAllContracts(_userId: string): Promise<void> {
    contractLog.deleteAllContracts();
  }

  async updateEvmChain(_userId: string, address: string, evmChain: string): Promise<boolean> {
    return contractLog.updateEvmChain(address, evmChain);
  }

  async enrichContract(
    _userId: string,
    address: string,
    patch: ContractEnrichmentPatch,
    options?: EnrichContractOptions,
  ): Promise<ContractEntry | null> {
    return contractLog.enrichContract(address, patch, options);
  }

  async hasAddress(_userId: string, address: string): Promise<boolean> {
    return contractLog.hasAddress(address);
  }

  async cacheUserName(_userId: string, discordUserId: string, displayName: string): Promise<void> {
    configStore.cacheUserName(discordUserId, displayName);
  }

  async logRevivalAlert(_userId: string, alert: RevivalAlertEntry): Promise<RevivalAlertEntry> {
    return revivalAlertLog.log(alert);
  }

  async listRevivalAlerts(_userId: string, limit?: number): Promise<RevivalAlertEntry[]> {
    return revivalAlertLog.list(limit);
  }

  async updateRevivalAlertOutcome(_userId: string, alertId: string, outcome: RevivalOutcomePatch): Promise<void> {
    revivalAlertLog.updateOutcome(alertId, outcome);
  }

  // ---- Trade journal ----

  async listJournalWallets(_userId: string): Promise<JournalWallet[]> {
    return journalLog.listWallets();
  }

  async addJournalWallet(_userId: string, address: string, label: string | null): Promise<JournalWallet> {
    return journalLog.addWallet(address, label);
  }

  async removeJournalWallet(_userId: string, walletId: string): Promise<boolean> {
    return journalLog.removeWallet(walletId);
  }

  async updateJournalWalletCursor(
    _userId: string,
    walletId: string,
    lastSignature: string | null,
    lastPolledAt: string,
  ): Promise<void> {
    journalLog.updateWalletCursor(walletId, lastSignature, lastPolledAt);
  }

  async addJournalTrades(_userId: string, trades: JournalTrade[]): Promise<number> {
    return journalLog.addTrades(trades);
  }

  async listJournalTrades(_userId: string, limit?: number, walletId?: string): Promise<JournalTrade[]> {
    return journalLog.listTrades(limit, walletId);
  }

  async replaceJournalPositions(_userId: string, walletId: string, positions: JournalPosition[]): Promise<void> {
    journalLog.replacePositionsForWallet(walletId, positions);
  }

  async listJournalPositions(_userId: string, status?: 'open' | 'closed'): Promise<JournalPosition[]> {
    return journalLog.listPositions(status);
  }

  async updateJournalPositionPrice(_userId: string, positionId: string, priceUsd: number, at: string): Promise<void> {
    journalLog.updatePositionPrice(positionId, priceUsd, at);
  }

  // ---- Price alerts ----

  async listPriceAlerts(_userId: string, status?: PriceAlertStatus): Promise<PriceAlert[]> {
    return priceAlertLog.list(status);
  }

  async createPriceAlert(_userId: string, input: PriceAlertInput): Promise<PriceAlert> {
    return priceAlertLog.create(input);
  }

  async deletePriceAlert(_userId: string, alertId: string): Promise<boolean> {
    return priceAlertLog.remove(alertId);
  }

  async updatePriceAlertObservation(
    _userId: string,
    alertId: string,
    patch: PriceAlertObservationPatch,
  ): Promise<void> {
    priceAlertLog.applyObservation(alertId, patch);
  }

  // ---- Market-cap-crossing filters ----
  //
  // Kept in the same config file as the rest of AppConfig rather than in a
  // store of its own: there is one local user, the values are four numbers, and
  // a separate file would need its own load/save/lock for no gain. Sanitized on
  // the way out because backend/data/config.json is a file a human can and does
  // hand-edit — a typo there must fall back to the env baseline, never open a
  // gate.

  async getMcapCrossFilters(_userId: string): Promise<McapCrossFilters> {
    const config = configStore.getConfig() as unknown as Record<string, unknown>;
    return sanitizeStoredFilters(config.mcapCrossFilters);
  }

  async setMcapCrossFilters(
    _userId: string,
    filters: McapCrossFilters,
  ): Promise<McapCrossFilters> {
    const clean = sanitizeStoredFilters(filters);
    configStore.updateConfig({ mcapCrossFilters: clean } as any);
    return clean;
  }
}
