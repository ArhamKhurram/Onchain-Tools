import type { StorageProvider } from '../interface.js';
import type { AppConfig, Room } from '../../discord/types.js';
import type { ContractEntry, ContractEnrichmentPatch, EnrichContractOptions } from '../../utils/contractLog.js';
import { createServiceClient, SupabaseContext } from './client.js';
import { ConfigRepo } from './configRepo.js';
import { TokensRepo } from './tokensRepo.js';
import { RoomsRepo } from './roomsRepo.js';
import { ContractsRepo } from './contractsRepo.js';
import { TelegramRepo } from './telegramRepo.js';
import { UserCacheRepo } from './userCacheRepo.js';

export class SupabaseStorageProvider implements StorageProvider {
  private config: ConfigRepo;
  private tokens: TokensRepo;
  private rooms: RoomsRepo;
  private contracts: ContractsRepo;
  private telegram: TelegramRepo;
  private userCache: UserCacheRepo;

  constructor() {
    const ctx = new SupabaseContext(createServiceClient());

    this.config = new ConfigRepo(ctx);
    this.tokens = new TokensRepo(ctx);
    this.rooms = new RoomsRepo(ctx);
    this.contracts = new ContractsRepo(ctx);
    this.telegram = new TelegramRepo(ctx);
    this.userCache = new UserCacheRepo(ctx);

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
}
