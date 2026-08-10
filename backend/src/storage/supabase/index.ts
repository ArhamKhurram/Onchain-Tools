import type { PumpSession, StorageProvider } from '../interface.js';
import type { AppConfig, Room } from '../../discord/types.js';
import type { ContractEntry, ContractEnrichmentPatch, EnrichContractOptions } from '../../utils/contractLog.js';
import type { RevivalAlertEntry, RevivalOutcomePatch } from '@oct/shared';
import { createServiceClient, SupabaseContext } from './client.js';
import { ConfigRepo } from './configRepo.js';
import { TokensRepo } from './tokensRepo.js';
import { PumpSessionRepo } from './pumpSessionRepo.js';
import { RoomsRepo } from './roomsRepo.js';
import { ContractsRepo } from './contractsRepo.js';
import { TelegramRepo } from './telegramRepo.js';
import { UserCacheRepo } from './userCacheRepo.js';
import { RevivalAlertsRepo } from './revivalAlertsRepo.js';

export class SupabaseStorageProvider implements StorageProvider {
  private config: ConfigRepo;
  private tokens: TokensRepo;
  private pumpSession: PumpSessionRepo;
  private rooms: RoomsRepo;
  private contracts: ContractsRepo;
  private telegram: TelegramRepo;
  private userCache: UserCacheRepo;
  private revivalAlerts: RevivalAlertsRepo;

  constructor() {
    const ctx = new SupabaseContext(createServiceClient());

    this.config = new ConfigRepo(ctx);
    this.tokens = new TokensRepo(ctx);
    this.pumpSession = new PumpSessionRepo(ctx);
    this.rooms = new RoomsRepo(ctx);
    this.contracts = new ContractsRepo(ctx);
    this.telegram = new TelegramRepo(ctx);
    this.userCache = new UserCacheRepo(ctx);
    this.revivalAlerts = new RevivalAlertsRepo(ctx);

    // Wire cross-repo dependencies (rooms ↔ config ↔ highlights/keywords seam).
    this.config.rooms = this.rooms;
    this.config.tokens = this.tokens;
    this.config.telegram = this.telegram;
    this.rooms.config = this.config;
  }

  // ---- Config ----

  getConfig(userId: string): Promise<AppConfig> {
    return this.config.getConfig(userId);
  }

  updateConfig(userId: string, partial: Partial<AppConfig>): Promise<AppConfig> {
    return this.config.updateConfig(userId, partial);
  }

  // ---- Tokens ----

  getTokens(userId: string): Promise<string[]> {
    return this.tokens.getTokens(userId);
  }

  setTokens(userId: string, tokens: string[]): Promise<void> {
    return this.tokens.setTokens(userId, tokens);
  }

  // ---- Pump.fun session bearer ----

  getPumpSession(userId: string): Promise<PumpSession | null> {
    return this.pumpSession.getPumpSession(userId);
  }

  setPumpSession(userId: string, token: string | null): Promise<void> {
    return this.pumpSession.setPumpSession(userId, token);
  }

  // ---- Rooms ----

  getRooms(userId: string): Promise<Room[]> {
    return this.rooms.getRooms(userId);
  }

  getRoom(userId: string, roomId: string): Promise<Room | null> {
    return this.rooms.getRoom(userId, roomId);
  }

  createRoom(userId: string, data: Omit<Room, 'id'>): Promise<Room> {
    return this.rooms.createRoom(userId, data);
  }

  updateRoom(userId: string, roomId: string, data: Partial<Room>): Promise<Room | null> {
    return this.rooms.updateRoom(userId, roomId, data);
  }

  deleteRoom(userId: string, roomId: string): Promise<boolean> {
    return this.rooms.deleteRoom(userId, roomId);
  }

  getRoomsForChannel(userId: string, channelId: string): Promise<Room[]> {
    return this.rooms.getRoomsForChannel(userId, channelId);
  }

  isChannelSubscribed(userId: string, channelId: string): Promise<boolean> {
    return this.rooms.isChannelSubscribed(userId, channelId);
  }

  isUserHighlighted(userId: string, discordUserId: string, roomId?: string, username?: string | null): Promise<boolean> {
    return this.rooms.isUserHighlighted(userId, discordUserId, roomId, username);
  }

  // ---- Contracts ----

  getContracts(userId: string, limit?: number, since?: string): Promise<ContractEntry[]> {
    return this.contracts.getContracts(userId, limit, since);
  }

  getContractByMessage(userId: string, messageId: string, address: string): Promise<ContractEntry | null> {
    return this.contracts.getContractByMessage(userId, messageId, address);
  }

  logContract(userId: string, entry: ContractEntry): Promise<ContractEntry> {
    return this.contracts.logContract(userId, entry);
  }

  deleteContract(userId: string, messageId: string, address: string): Promise<boolean> {
    return this.contracts.deleteContract(userId, messageId, address);
  }

  deleteAllContracts(userId: string): Promise<void> {
    return this.contracts.deleteAllContracts(userId);
  }

  updateEvmChain(userId: string, address: string, evmChain: string): Promise<boolean> {
    return this.contracts.updateEvmChain(userId, address, evmChain);
  }

  enrichContract(
    userId: string,
    address: string,
    patch: ContractEnrichmentPatch,
    options?: EnrichContractOptions,
  ): Promise<ContractEntry | null> {
    return this.contracts.enrichContract(userId, address, patch, options);
  }

  hasAddress(userId: string, address: string): Promise<boolean> {
    return this.contracts.hasAddress(userId, address);
  }

  // ---- User name cache ----

  cacheUserName(userId: string, discordUserId: string, displayName: string): Promise<void> {
    return this.userCache.cacheUserName(userId, discordUserId, displayName);
  }

  // ---- Revival alerts ----

  logRevivalAlert(userId: string, alert: RevivalAlertEntry): Promise<RevivalAlertEntry> {
    return this.revivalAlerts.logRevivalAlert(userId, alert);
  }

  listRevivalAlerts(userId: string, limit?: number): Promise<RevivalAlertEntry[]> {
    return this.revivalAlerts.listRevivalAlerts(userId, limit);
  }

  updateRevivalAlertOutcome(userId: string, alertId: string, outcome: RevivalOutcomePatch): Promise<void> {
    return this.revivalAlerts.updateRevivalAlertOutcome(userId, alertId, outcome);
  }
}
