import type { AppConfig, Room } from '../discord/types.js';
import type { McapCrossFilters } from '../mcapCross/filters.js';
import type { ContractEntry, ContractEnrichmentPatch, EnrichContractOptions } from '../utils/contractLog.js';
import type {
  JournalPosition,
  JournalTrade,
  JournalWallet,
  PriceAlert,
  PriceAlertDirection,
  PriceAlertMetric,
  PriceAlertStatus,
  RevivalAlertEntry,
  RevivalOutcomePatch,
} from '@oct/shared';

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

/** What a caller supplies to create a price alert; the store owns the rest. */
export interface PriceAlertInput {
  mint: string;
  chain: string;
  symbol: string | null;
  direction: PriceAlertDirection;
  targetUsd: number;
  metric: PriceAlertMetric;
  note: string | null;
}

/**
 * One poll observation. `lastSeenUsd`/`lastSeenAt` are written every time a
 * real value is observed; the remaining fields appear together, exactly once,
 * on the crossing that fires the alert.
 */
export interface PriceAlertObservationPatch {
  lastSeenUsd: number;
  lastSeenAt: string;
  /** Present only on a firing observation. */
  status?: PriceAlertStatus;
  firedAt?: string;
  firedValueUsd?: number;
  /** Learned upstream; only ever set, never cleared. */
  symbol?: string | null;
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
  /**
   * Column-scoped contract read for the caller-scoring board. `getContracts` does
   * `select('*')`, dragging message text, description, and every enrichment/display
   * column across the wire for up to MAX_CONTRACTS (20k) rows — the single largest
   * source of Supabase egress on the derived-scores path. This returns only the
   * fields `buildCallerScores` + `getPeaks` read; all other ContractEntry fields
   * come back blank/undefined. Locally it may delegate to `getContracts` (no egress).
   */
  getContractsForScoring(userId: string, limit?: number, since?: string): Promise<ContractEntry[]>;
  /** One specific logged row, for callers that know exactly which row they mean. */
  getContractByMessage(userId: string, messageId: string, address: string): Promise<ContractEntry | null>;
  logContract(userId: string, entry: ContractEntry): Promise<ContractEntry>;
  deleteContract(userId: string, messageId: string, address: string): Promise<boolean>;
  deleteAllContracts(userId: string): Promise<void>;
  updateEvmChain(userId: string, address: string, evmChain: string): Promise<boolean>;
  enrichContract(userId: string, address: string, patch: ContractEnrichmentPatch, options?: EnrichContractOptions): Promise<ContractEntry | null>;
  hasAddress(userId: string, address: string): Promise<boolean>;

  cacheUserName(userId: string, discordUserId: string, displayName: string): Promise<void>;

  // ---- Revival alerts (fired-alert log + 24h outcome tracking) ----

  /** Persist a fired revival alert (id supplied by the caller). */
  logRevivalAlert(userId: string, alert: RevivalAlertEntry): Promise<RevivalAlertEntry>;
  /** Newest-first list of stored revival alerts. */
  listRevivalAlerts(userId: string, limit?: number): Promise<RevivalAlertEntry[]>;
  /** Merge an outcome patch (peak fields / window close) into one alert row. */
  updateRevivalAlertOutcome(userId: string, alertId: string, outcome: RevivalOutcomePatch): Promise<void>;

  // ---- Trade journal (the user's OWN wallets; see backend/src/journal/) ----

  listJournalWallets(userId: string): Promise<JournalWallet[]>;
  /** Idempotent on (userId, address): re-adding returns the existing wallet. */
  addJournalWallet(userId: string, address: string, label: string | null): Promise<JournalWallet>;
  /** Removes the wallet AND its trades/positions. */
  removeJournalWallet(userId: string, walletId: string): Promise<boolean>;
  /** Advance the ingestion cursor after a successful poll. */
  updateJournalWalletCursor(
    userId: string,
    walletId: string,
    lastSignature: string | null,
    lastPolledAt: string,
  ): Promise<void>;

  /** Insert trades, idempotent on (walletId, txSignature, mint, side). Returns rows added. */
  addJournalTrades(userId: string, trades: JournalTrade[]): Promise<number>;
  /** Newest-first. `walletId` narrows to one wallet. */
  listJournalTrades(userId: string, limit?: number, walletId?: string): Promise<JournalTrade[]>;

  /** Replace a wallet's positions wholesale (the pairing engine rebuilds them each ingest). */
  replaceJournalPositions(userId: string, walletId: string, positions: JournalPosition[]): Promise<void>;
  listJournalPositions(userId: string, status?: 'open' | 'closed'): Promise<JournalPosition[]>;
  /** Side-write from the volume poller: last observed DexScreener price. */
  updateJournalPositionPrice(userId: string, positionId: string, priceUsd: number, at: string): Promise<void>;

  // ---- Price alerts (operator-set levels; see backend/src/priceAlerts/) ----

  /** Newest-first. `status` narrows to one state ('armed' for the poller). */
  listPriceAlerts(userId: string, status?: PriceAlertStatus): Promise<PriceAlert[]>;
  /** Create one armed alert. Server owns id/status/createdAt. */
  createPriceAlert(userId: string, input: PriceAlertInput): Promise<PriceAlert>;
  deletePriceAlert(userId: string, alertId: string): Promise<boolean>;
  /**
   * Persist one poll observation. `lastSeenUsd` is always written; the fired
   * fields are written together, and only on a genuine crossing (one-shot).
   */
  updatePriceAlertObservation(
    userId: string,
    alertId: string,
    patch: PriceAlertObservationPatch,
  ): Promise<void>;

  // ---- Market-cap-crossing filters (per user; see backend/src/mcapCross/) ----

  /**
   * The caller's own gate-threshold overrides. Only keys the user deliberately
   * set are present; everything absent inherits the env baseline, which is what
   * makes "a user who has changed nothing sees today's behaviour" structural
   * rather than a promise. Both providers keep it in the same JSON settings
   * blob the rest of AppConfig uses, so this costs no new table and no new
   * migration; the Supabase side reads the one `settings` column rather than a
   * whole config bundle, per the egress rule.
   *
   * Never throws: an unreadable store returns `{}` and the poller falls back to
   * the operator baseline. A filter read must not be able to break a sweep.
   */
  getMcapCrossFilters(userId: string): Promise<McapCrossFilters>;
  /**
   * Replace the caller's overrides wholesale. The caller is responsible for
   * validating first (`validateFilterPatch`) and for merging a patch onto the
   * current value (`applyFilterPatch`); this method stores what it is given.
   */
  setMcapCrossFilters(userId: string, filters: McapCrossFilters): Promise<McapCrossFilters>;
}
