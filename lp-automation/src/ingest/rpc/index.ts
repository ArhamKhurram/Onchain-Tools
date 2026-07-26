// Low-latency chain-watch layer (LP_AUTOMATION_PLAN.md §3, §10 step 4).
//
// Krystal's REST API cannot deliver sub-second reaction to price leaving a
// range; this module watches the pools we hold positions in directly over RPC
// and reports crossings. It observes only — `src/rules/` decides.
//
// Typical wiring:
//
//   const watcher = new PoolWatcher({
//     config: loadRpcConfig(),
//     ranges: positions.map(toWatchedRange),
//     callbacks: {
//       onCrossing: (e) => { if (e.phase === 'confirmed') rules.onRangeExit(e); },
//       onStale:    (a) => alerting.pageOperator(a),
//       onStatus:   (s) => { if (!s.lowLatency) alerting.degraded(s.reason); },
//     },
//   });
//   watcher.start();

export { PoolWatcher, type PoolWatcherOptions } from './poolWatcher.js';

export {
  defineRobinhoodChain,
  ROBINHOOD_BLOCK_TIME_MS,
  type RobinhoodChainParams,
} from './chain.js';

export {
  loadRpcConfig,
  parseRpcConfig,
  RpcConfigError,
  RPC_CONFIG_DEFAULTS,
  type PreferredMode,
  type RpcConfig,
} from './config.js';

export {
  BURN_EVENT,
  LIQUIDITY_EVENTS,
  MINT_EVENT,
  SWAP_EVENT,
  UNISWAP_V3_POOL_ABI,
} from './abi.js';

export {
  assertValidRange,
  assertValidTick,
  evaluateRange,
  isOutsideRange,
  MAX_TICK,
  MIN_TICK,
  priceToNearestTick,
  priceToTick,
  TICK_BASE,
  tickToPrice,
  TickRangeError,
  type RangeEvaluation,
  type RangeEvaluationOptions,
  type RangeSide,
} from './tickMath.js';

export {
  backoffDelayMs,
  DEFAULT_BACKOFF,
  evaluateStaleness,
  isStale,
  type BackoffOptions,
  type StalenessEvaluation,
} from './health.js';

export {
  compareLogOrder,
  confirmationDepth,
  isConfirmed,
  pickLatestLog,
  type OrderedLog,
} from './observations.js';

export type {
  ConfirmedCrossing,
  CrossingEvent,
  LiquidityChange,
  ObservedCrossing,
  PoolWatcherCallbacks,
  RevertedCrossing,
  StaleAlert,
  TickObservation,
  WatchMode,
  WatchedRange,
  WatcherError,
  WatcherHealth,
  WatcherLogger,
  WatcherStatus,
} from './types.js';
