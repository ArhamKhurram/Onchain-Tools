// Rule evaluator (plan §6) — efficiency scoring, compound/rebalance triggers,
// and the switching buffer. Every function is pure: no clock, no chain, no API.
// `now` and every cost input are supplied by the caller so the whole decision
// surface is reproducible from an audit-log snapshot.

export { computeEfficiency, DAYS_PER_YEAR, PROHIBITIVE_COST_DRAG } from './efficiency.js';
export {
  shouldCompound,
  shouldRebalance,
  tickToPrice,
  computeRangeExitPercent,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  TICK_BASE,
} from './triggers.js';
export {
  evaluateSwitch,
  DEFAULT_MAX_OBSERVATION_GAP_MINUTES,
} from './switching.js';
export type {
  ScoredPool,
  CrossoverState,
  SwitchEvaluation,
  SwitchOptions,
} from './switching.js';
