import { configStore } from '../config/store.js';
import { contractLog } from '../utils/contractLog.js';
import { revivalAlertLog } from '../utils/revivalAlertLog.js';
import { pumpSessionStore } from '../pumpfun/pumpSessionStore.js';
import type { PumpSession, StorageProvider } from './interface.js';
import type { AppConfig, Room } from '../discord/types.js';
import type { ContractEntry, ContractEnrichmentPatch, EnrichContractOptions } from '../utils/contractLog.js';
import type { RevivalAlertEntry, RevivalOutcomePatch } from '@oct/shared';

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
}
