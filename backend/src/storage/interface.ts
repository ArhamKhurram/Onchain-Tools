import type { AppConfig, Room } from '../discord/types.js';
import type { ContractEntry, ContractEnrichmentPatch, EnrichContractOptions } from '../utils/contractLog.js';

/**
 * A stored pump.fun session bearer plus the moment it was stored.
 *
 * `token` is a live credential (a ~30-day JWT that authenticates AS the user).
 * It is an IN-PROCESS value only: it is read late, at the moment of an upstream
 * call, and NEVER placed in an HTTP response, a log line, or an error string.
 * `updatedAt` is the only field a status read may surface (alongside the JWT's
 * decoded `exp`, which is derived from the token but never the token itself).
 */
export interface PumpSession {
  token: string;
  updatedAt: string;
}

export interface StorageProvider {
  getConfig(userId: string): Promise<AppConfig>;
  updateConfig(userId: string, partial: Partial<AppConfig>): Promise<AppConfig>;

  getTokens(userId: string): Promise<string[]>;
  setTokens(userId: string, tokens: string[]): Promise<void>;

  /**
   * The caller's pump.fun session bearer, or null when not connected. Read late
   * (per upstream call) so an expired/rotated token is never cached in a client.
   * The returned `token` must never be serialized to a response.
   */
  getPumpSession(userId: string): Promise<PumpSession | null>;
  /** Store a pump.fun bearer, or clear it when passed null. Encrypted at rest in hosted mode. */
  setPumpSession(userId: string, token: string | null): Promise<void>;

  getRooms(userId: string): Promise<Room[]>;
  getRoom(userId: string, roomId: string): Promise<Room | null>;
  createRoom(userId: string, data: Omit<Room, 'id'>): Promise<Room>;
  updateRoom(userId: string, roomId: string, data: Partial<Room>): Promise<Room | null>;
  deleteRoom(userId: string, roomId: string): Promise<boolean>;

  getRoomsForChannel(userId: string, channelId: string): Promise<Room[]>;
  isChannelSubscribed(userId: string, channelId: string): Promise<boolean>;
  isUserHighlighted(userId: string, discordUserId: string, roomId?: string, username?: string | null): Promise<boolean>;

  getContracts(userId: string, limit?: number, since?: string): Promise<ContractEntry[]>;
  /** One specific logged row, for callers that know exactly which row they mean. */
  getContractByMessage(userId: string, messageId: string, address: string): Promise<ContractEntry | null>;
  logContract(userId: string, entry: ContractEntry): Promise<ContractEntry>;
  deleteContract(userId: string, messageId: string, address: string): Promise<boolean>;
  deleteAllContracts(userId: string): Promise<void>;
  updateEvmChain(userId: string, address: string, evmChain: string): Promise<boolean>;
  enrichContract(userId: string, address: string, patch: ContractEnrichmentPatch, options?: EnrichContractOptions): Promise<ContractEntry | null>;
  hasAddress(userId: string, address: string): Promise<boolean>;

  cacheUserName(userId: string, discordUserId: string, displayName: string): Promise<void>;
}
