// Arm-time guard on regex leaves in a matcher tree.
//
// THIS IS A HEURISTIC, NOT A PROOF. It is a conservative structural reject, not
// linear-time validation: it refuses a pattern that fails to compile, that is
// long enough to be worth refusing on size alone, or that carries the classic
// nested-quantifier shape. A real guarantee needs an RE2-class engine, and until
// there is one a sufficiently clever pattern can still backtrack.
//
// It is worth keeping anyway because it is cheap and because it means an
// obviously-quadratic pattern cannot be PERSISTED. That matters most in Phase 3,
// where the regex is model output rather than something a human typed
// (docs/architecture/sniper-security.md, threat T5).
//
// Arm-time only. The matcher has no producer in the alpha — OCT reads no tweets —
// so nothing evaluates these patterns at runtime yet.

/** Long patterns are refused on size alone; nothing legitimate in a rule needs more. */
const MAX_PATTERN_LENGTH = 200;

/**
 * A quantified group that itself contains a quantifier: (a+)+, (a*)* , (\w+)*
 * and friends. This is the shape behind essentially every published ReDoS, and
 * it is the one shape a string scan can recognise without a parser.
 */
const NESTED_QUANTIFIER = /\([^()]*[+*]\)[+*{]/;

export function isLinearSafeRegex(source: string): boolean {
  if (source.length > MAX_PATTERN_LENGTH) return false;
  try {
    // Compiling is the only way to reject a syntactically invalid pattern
    // before it reaches storage — an invalid leaf would otherwise throw inside
    // matchKeywords at evaluation time, i.e. mid-fire.
    new RegExp(source);
  } catch {
    return false;
  }
  return !NESTED_QUANTIFIER.test(source);
}
