// Krystal read-only data layer (plan §3).
//
// Everything here is READ-ONLY. Nothing in this directory builds, signs or
// broadcasts a transaction — calldata lives in `src/calldata/`.

export {
  KRYSTAL_BASE_URL,
  KrystalBlockedError,
  KrystalClient,
  KrystalHttpError,
  KrystalRateLimitError,
  KrystalTimeoutError,
  assertNoWafTripwire,
  buildQueryString,
  getKrystalClient,
  setKrystalClient,
  type KrystalClientOptions,
  type Query,
  type QueryValue,
  type RateLimitEvent,
} from './client.js';

export {
  KrystalFieldError,
  normalizeAddress,
  feePercentToUnits,
  percentToFraction,
} from './coerce.js';

export {
  PHASE1_PLATFORM,
  PLATFORM_UNISWAP_V3,
  PLATFORM_UNISWAP_V4,
  ROBINHOOD_PLATFORMS,
  isSupportedPhase1Target,
  type RobinhoodPlatform,
} from './platform.js';

export {
  TOP_POOLS_PATH,
  fetchPools,
  indexPoolsByAddress,
  mapPoolCandidate,
  mapTopPools,
  type FetchPoolsOptions,
  type MappedPools,
  type SkippedEntry,
} from './pools.js';

export {
  USER_POSITIONS_PATH,
  deriveTick,
  fetchUserPositions,
  mapLpPosition,
  mapPositionStatus,
  mapUserPositions,
  sumUsdQuotes,
  type FetchUserPositionsOptions,
  type IncompletePosition,
  type MapPositionsContext,
  type MappedPositions,
  type PoolTickState,
} from './positions.js';
