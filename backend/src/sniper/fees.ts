// Fee estimation, in native units. The reservation must debit the amount PLUS
// fees — Slotshark's 0.5%, plus any Solana tip/priority fee — or a daily cap is
// soft by an unbounded margin (docs/architecture/sniper-execution.md).
//
// M1 uses conservative flat estimates. When a venue returns real fee data on a
// fill, reconciliation trues up the reservation against it.
//
// ---------------------------------------------------------------------------
// GLOBAL (account-level) tip + priority fee
// ---------------------------------------------------------------------------
//
// The tip and the priority fee are properties of how the OPERATOR bids for
// blockspace, not of any one rule, so they live once on the account
// (`SniperStore.getFeeSettings`) and every rule inherits them.
//
// PRECEDENCE — a rule-level value, when EXPLICITLY set, wins; otherwise the
// global applies:
//
//     effectiveTip = rule.exec.tip ?? global.tip
//
// `SolanaExecParams.tip` is already optional and `undefined` already meant "I
// did not set this" (the venue picks its auto value). That is exactly the
// "inherit" signal, so no rule data has to move: a rule that never set a tip
// now inherits the global, and a rule that set one keeps it as an explicit
// override. Because the global DEFAULTS TO ZERO, an existing install's fee
// arithmetic is byte-for-byte what it was until the operator deliberately sets
// a global — this change cannot silently alter what an existing rule spends.
//
// SAFETY — every value that reaches the arithmetic goes through
// `normalizeFeeSettings`/`safeComponent` first. A NaN, an undefined, an
// Infinity or a negative would each corrupt the reservation (`amountWithFees`
// becomes NaN, and `NaN > cap` is FALSE — the cap turns off rather than
// tightening), so a bad value is coerced to 0 here and refused outright at the
// API boundary. Never relax this into a bare `Number(x)`.

import type { SnipeRule, SniperFeeSettings, Venue } from './types.js';

/** Slotshark charges 0.5% per trade. Reconciliation trues this up on fill. */
export const VENUE_FEE_RATE: Record<Venue, number> = {
  slotshark: 0.005,
  dryrun: 0.005, // dry run mirrors a real fee so caps are exercised realistically
};

/**
 * What an account has before the operator sets anything. ZERO on both
 * components on purpose: it reproduces the pre-global behaviour exactly, so
 * introducing the setting changes no existing reservation.
 */
export const DEFAULT_FEE_SETTINGS: SniperFeeSettings = { tip: 0, priorityFee: 0 };

/**
 * Ceiling for a single fee component, in native units.
 *
 * This is a RISK LIMIT, not just an overflow guard. It started as the latter
 * (1000, picked only so a fat-fingered `1e308` could not be stored and then
 * overflow to Infinity when the components are summed) — but 1000 SOL is not a
 * guard against anything a human would actually mistype. A real Jito-style tip
 * is thousandths of a SOL; an accidental extra zero or a misplaced decimal is
 * the failure this has to catch, and only a ceiling near the plausible range
 * does that.
 *
 * 1 SOL is therefore the default: far above any honest tip, far below an amount
 * whose loss would matter. `SNIPER_MAX_FEE_COMPONENT` raises it for an operator
 * who genuinely bids higher, and the value is still bounded so the env var
 * cannot reintroduce the overflow this also prevents.
 *
 * The DB CHECK constraint stays at 1000 (see the sniper_global_fee_settings
 * migration): the app ceiling is deliberately the tighter of the two, so
 * lowering it here needs no migration.
 */
const MAX_FEE_COMPONENT_HARD_LIMIT = 1_000;
const DEFAULT_MAX_FEE_COMPONENT = 1;

function readMaxFeeComponent(): number {
  const raw = process.env.SNIPER_MAX_FEE_COMPONENT;
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_FEE_COMPONENT;
  const parsed = Number(raw);
  // A malformed override must not widen the limit — fall back, never open up.
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_FEE_COMPONENT;
  return Math.min(parsed, MAX_FEE_COMPONENT_HARD_LIMIT);
}

export const MAX_FEE_COMPONENT = readMaxFeeComponent();

/** A storable fee component: finite, not negative, not absurd. */
export function isValidFeeComponent(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_FEE_COMPONENT;
}

/**
 * Parse ONE fee component arriving from an untrusted surface — an HTTP body, a
 * Telegram command argument — into a storable number, or `null` for "refuse".
 *
 * ONE PARSER, EVERY SURFACE. `/sniper/v1/fees` had these rules inline; the
 * Telegram `/fees` command needs exactly the same ones, and a second copy is
 * how two surfaces drift until one accepts what the other refuses. The bounds
 * live in `isValidFeeComponent` and are never restated by a caller.
 *
 *   • `undefined` → `fallback`. Absent means "leave this component alone", so
 *     one field can be patched without resending the other.
 *   • a number → accepted only if `isValidFeeComponent`; otherwise REFUSED,
 *     never coerced. A negative or a NaN does not tighten a cap, it disables
 *     cap accounting (`NaN > cap` is false), and silently storing a coerced 0
 *     would tell the operator their tip landed when it was discarded.
 *   • a string → a form field or a chat message; parsed, then held to the same
 *     test. A blank string is not a zero.
 *   • anything else (null, boolean, object) → REFUSED. `null` in particular is
 *     what JSON.stringify makes of Infinity, so reading it as zero would write
 *     0 for an operator who typed something enormous.
 */
export function parseFeeComponent(v: unknown, fallback: number): number | null {
  if (v === undefined) return fallback;
  if (typeof v === 'number') return isValidFeeComponent(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return isValidFeeComponent(n) ? n : null;
  }
  return null;
}

/**
 * Last line of defence, applied at every read. Anything that is not a valid
 * component becomes 0 rather than propagating — a NaN in `amountWithFees` makes
 * EVERY cap comparison false, which disables cap accounting outright.
 */
function safeComponent(v: unknown): number {
  return isValidFeeComponent(v) ? v : 0;
}

/**
 * Coerce whatever a store handed back (a JSON file an operator may have edited,
 * a Postgres numeric that arrives as a string, a missing column on an older row)
 * into settings the fee arithmetic can trust.
 */
export function normalizeFeeSettings(raw: unknown): SniperFeeSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FEE_SETTINGS };
  const r = raw as { tip?: unknown; priorityFee?: unknown };
  // Postgres `numeric` comes back as a string through PostgREST; coerce before
  // validating, but only from string/number — never from null/undefined/{}, all
  // of which `Number()` maps to 0 or NaN and would read as "operator set zero".
  const num = (v: unknown): unknown => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
  return {
    tip: safeComponent(num(r.tip)),
    priorityFee: safeComponent(num(r.priorityFee)),
  };
}

/**
 * The tip and priority fee this rule actually bids, after inheritance. Exported
 * because the console renders the same number and the executor will need it the
 * day OCT submits transactions itself.
 */
export function resolveExecFees(
  rule: Pick<SnipeRule, 'exec'>,
  global: SniperFeeSettings,
): { tip: number; priorityFee: number } {
  const g = normalizeFeeSettings(global);
  if (rule.exec.kind !== 'sol') {
    // EVM prices gas in wei on a different asset; the Solana tip/priority-fee
    // knobs have no meaning there and the global must not leak into an EVM
    // rule's native-unit accounting.
    return { tip: 0, priorityFee: 0 };
  }
  return {
    tip: rule.exec.tip === undefined ? g.tip : safeComponent(rule.exec.tip),
    priorityFee: rule.exec.priorityFee === undefined ? g.priorityFee : safeComponent(rule.exec.priorityFee),
  };
}

/**
 * Fees for ONE leg, in native units.
 *
 * `global` is REQUIRED, deliberately: an optional parameter would let a future
 * call site drop it and silently under-reserve by the whole tip. Callers on the
 * money path read it once per fire from the store so a fire is internally
 * consistent even if the operator edits the setting mid-fire.
 */
export function estimateFees(rule: SnipeRule, legAmount: number, global: SniperFeeSettings): number {
  const rate = VENUE_FEE_RATE[rule.venue] ?? 0.005;
  const amount = Number.isFinite(legAmount) && legAmount > 0 ? legAmount : 0;
  const { tip, priorityFee } = resolveExecFees(rule, global);
  // EVM gas is denominated in wei on a different asset; for native-unit cap
  // accounting we treat it as covered by the rate buffer in v1 and reconcile on
  // fill. Modelled explicitly here so the omission is a decision, not an oversight.
  return amount * rate + tip + priorityFee;
}
