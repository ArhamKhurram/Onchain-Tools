import { useEffect, useRef, useState } from 'react';
import { Toggle } from '../settings/fields';
import SniperModalShell, { SniperModalHeader } from './SniperModalShell';
import {
  parseLadderSplit,
  triggerTotalPreview,
  validateLadderSplit,
  type MatcherNode,
  type SnipeRule,
  type SniperFeeSettings,
  type SniperWallet,
} from '../../types/sniper';
import type { SnipeRuleDraft } from '../../hooks/useSniperRules';

const FIELD =
  'oct-input w-full px-comfy py-cozy type-body font-mono disabled:opacity-60 disabled:cursor-not-allowed';
const LABEL = 'block type-label text-oct-muted mb-snug uppercase tracking-wide';
const SECTION = 'oct-eyebrow border-b border-oct-border pb-snug';
/** Hint copy under a field. `type-caption` is the 12px floor; nothing renders below it. */
const HINT = 'type-caption font-normal text-oct-muted leading-relaxed';

interface FormState {
  name: string;
  mint: string;
  entryStyle: 'single' | 'ladder';
  ladderSplitText: string;
  sizeUnit: SnipeRule['sizeUnit'];
  sizeTotal: number;
  walletIds: string[];
  perFireCap: number;
  perTriggerCap: number;
  slippageBps: number;
  tip: string;
  priorityFee: string;
  antimev: boolean;
  fireWindowMs: number;
  maxAttempts: number;
  mcapCeiling: string;
  autoDisableAfterFire: boolean;
  /** Stored, never read. See the disabled fieldset. */
  handlesText: string;
  keywordsText: string;
}

const DEFAULTS: FormState = {
  name: '',
  mint: '',
  entryStyle: 'single',
  ladderSplitText: '',
  sizeUnit: 'SOL',
  sizeTotal: 0.05,
  walletIds: [],
  perFireCap: 0.1,
  perTriggerCap: 0.2,
  slippageBps: 500,
  tip: '',
  priorityFee: '',
  antimev: true,
  fireWindowMs: 30_000,
  maxAttempts: 3,
  mcapCeiling: '',
  autoDisableAfterFire: true,
  handlesText: '',
  keywordsText: '',
};

/** Flatten the persisted matcher back into the comma list the form authors. */
function matcherToText(node: MatcherNode): string {
  if (node.op === 'leaf') return node.pattern.pattern;
  if (node.op === 'not') return matcherToText(node.child);
  return node.children.map(matcherToText).filter(Boolean).join(', ');
}

function textToMatcher(raw: string): MatcherNode {
  const terms = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    op: 'or',
    children: terms.map((t) => ({ op: 'leaf' as const, pattern: { pattern: t, matchMode: 'includes' as const } })),
  };
}

function ruleToForm(rule: SnipeRule): FormState {
  return {
    name: rule.name,
    mint: rule.mint ?? '',
    entryStyle: rule.entryStyle,
    ladderSplitText: (rule.ladderSplit ?? []).join(', '),
    sizeUnit: rule.sizeUnit,
    sizeTotal: rule.sizeTotal,
    walletIds: rule.walletIds,
    perFireCap: rule.perFireCap,
    perTriggerCap: rule.perTriggerCap,
    slippageBps: rule.slippageBps,
    tip: rule.exec.kind === 'sol' && rule.exec.tip !== undefined ? String(rule.exec.tip) : '',
    priorityFee: rule.exec.kind === 'sol' && rule.exec.priorityFee !== undefined ? String(rule.exec.priorityFee) : '',
    antimev: rule.exec.kind === 'sol' ? rule.exec.antimev : true,
    fireWindowMs: rule.fireWindowMs,
    maxAttempts: rule.maxAttempts,
    mcapCeiling: rule.mcapCeiling === null ? '' : String(rule.mcapCeiling),
    autoDisableAfterFire: rule.autoDisableAfterFire,
    handlesText: rule.handles.join(', '),
    keywordsText: matcherToText(rule.matcher),
  };
}

function formToDraft(f: FormState): SnipeRuleDraft {
  const optionalNumber = (raw: string): number | undefined => {
    const n = Number(raw);
    return raw.trim() === '' || !Number.isFinite(n) ? undefined : n;
  };

  return {
    name: f.name.trim(),
    // Phase 1 + Solana + Slotshark is the whole alpha; the form does not offer
    // the alternatives because nothing behind it accepts them.
    chain: 'sol',
    venue: 'slotshark',
    handles: f.handlesText
      .split(',')
      .map((h) => h.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean),
    interactionTypes: ['tweet'],
    matcher: textToMatcher(f.keywordsText),
    phase: 1,
    mint: f.mint.trim() || null,
    entryStyle: f.entryStyle,
    ladderSplit: f.entryStyle === 'ladder' ? parseLadderSplit(f.ladderSplitText) : null,
    sizeUnit: f.sizeUnit,
    sizeTotal: f.sizeTotal,
    walletIds: f.walletIds,
    perFireCap: f.perFireCap,
    perTriggerCap: f.perTriggerCap,
    slippageBps: f.slippageBps,
    exec: {
      kind: 'sol',
      tip: optionalNumber(f.tip),
      priorityFee: optionalNumber(f.priorityFee),
      antimev: f.antimev,
    },
    maxTweetAgeMs: 60_000,
    fireWindowMs: f.fireWindowMs,
    maxAttempts: f.maxAttempts,
    mcapCeiling: optionalNumber(f.mcapCeiling) ?? null,
    autoDisableAfterFire: f.autoDisableAfterFire,
  };
}

interface SniperRuleFormModalProps {
  open: boolean;
  mode: 'add' | 'edit';
  rule?: SnipeRule | null;
  wallets: SniperWallet[];
  /**
   * Account-level fees. Blank tip/priority inputs INHERIT these rather than
   * meaning zero, so the trigger-total preview has to be computed against them
   * or it understates what the server will reserve.
   */
  fees: SniperFeeSettings;
  onClose: () => void;
  onSubmit: (draft: SnipeRuleDraft) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
}

/**
 * The rule editor.
 *
 * There is deliberately NO state control and NO dry-run control anywhere in this
 * form. Arming and going live are separate confirmed calls on the row, which is
 * what makes "saving a rule can never fire it" a structural property of the UI
 * rather than something a future edit has to remember.
 */
export default function SniperRuleFormModal({
  open,
  mode,
  rule,
  wallets,
  fees,
  onClose,
  onSubmit,
}: SniperRuleFormModalProps) {
  const [values, setValues] = useState<FormState>(DEFAULTS);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValues(mode === 'edit' && rule ? ruleToForm(rule) : DEFAULTS);
    setFieldError(null);
    setSubmitting(false);
    setTimeout(() => nameRef.current?.focus(), 50);
  }, [open, mode, rule]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, submitting, onClose]);

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setFieldError(null);
  };

  const draft = formToDraft(values);
  // Σ over every leg of (amount + fees) — what perTriggerCap actually bounds.
  // Shown live because a rule whose own legs cannot clear its own trigger cap is
  // rejected at arm time, and finding that out three clicks later is worse.
  const triggerTotal = triggerTotalPreview(draft, fees);
  const legCount = draft.walletIds.length * (draft.entryStyle === 'ladder' ? (draft.ladderSplit?.length ?? 1) : 1);
  const overTriggerCap = draft.walletIds.length > 0 && triggerTotal > draft.perTriggerCap;

  const toggleWallet = (walletId: string) => {
    setValues((prev) => ({
      ...prev,
      walletIds: prev.walletIds.includes(walletId)
        ? prev.walletIds.filter((id) => id !== walletId)
        : [...prev.walletIds, walletId],
    }));
    setFieldError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!draft.name) {
      setFieldError('A rule needs a name.');
      return;
    }
    if (!draft.mint) {
      setFieldError('A phase 1 rule binds its mint up front — without one it would abort with no_mint on every fire.');
      return;
    }
    if (values.entryStyle === 'ladder') {
      const split = validateLadderSplit(draft.ladderSplit);
      if (!split.ok) {
        setFieldError(
          split.reason === 'not_normalized'
            ? 'Ladder weights must sum to exactly 1.'
            : split.reason === 'too_many'
              ? 'A ladder may have at most 10 legs.'
              : split.reason === 'negative'
                ? 'Every ladder weight must be a positive number.'
                : 'Enter ladder weights, e.g. 0.5, 0.3, 0.2',
        );
        return;
      }
    }

    setSubmitting(true);
    const res = await onSubmit(draft);
    setSubmitting(false);
    if (res.ok) onClose();
    else setFieldError(res.detail ? `${res.reason} — ${res.detail}` : res.reason);
  };

  return (
    <SniperModalShell open={open} onBackdropClick={() => !submitting && onClose()} className="max-w-2xl">
      <SniperModalHeader
        title={mode === 'add' ? 'New snipe rule' : 'Edit snipe rule'}
        onClose={onClose}
        disabled={submitting}
      />

      <form onSubmit={handleSubmit} className="px-roomy py-comfy space-y-roomy max-h-[70vh] overflow-y-auto">
        <p className="type-body text-oct-muted leading-relaxed">
          Saving writes a <span className="font-mono text-oct-text">draft</span> in dry-run. Arming, going live and
          firing are three further, separate confirmations on the rule row.
        </p>

        {/* Identity + target ------------------------------------------------ */}
        <div className="space-y-comfy">
          <p className={SECTION}>Identity &amp; target</p>
          <div>
            <label htmlFor="sniper-rule-name" className={LABEL}>
              Name
            </label>
            <input
              ref={nameRef}
              id="sniper-rule-name"
              type="text"
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Test buy — WIF"
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="sniper-rule-mint" className={LABEL}>
              Mint
            </label>
            <input
              id="sniper-rule-mint"
              type="text"
              value={values.mint}
              onChange={(e) => set('mint', e.target.value)}
              placeholder="Token mint address…"
              className={FIELD}
            />
          </div>
        </div>

        {/* Sizing ----------------------------------------------------------- */}
        <div className="space-y-comfy">
          <p className={SECTION}>Sizing</p>
          <div className="grid grid-cols-3 gap-comfy">
            <div>
              <label htmlFor="sniper-rule-unit" className={LABEL}>
                Unit
              </label>
              <select
                id="sniper-rule-unit"
                value={values.sizeUnit}
                onChange={(e) => set('sizeUnit', e.target.value as FormState['sizeUnit'])}
                className={FIELD}
              >
                <option value="SOL">SOL</option>
                <option value="USDC">USDC</option>
              </select>
            </div>
            <div>
              <label htmlFor="sniper-rule-size" className={LABEL}>
                Size per wallet
              </label>
              <input
                id="sniper-rule-size"
                type="number"
                step="any"
                min="0"
                value={values.sizeTotal}
                onChange={(e) => set('sizeTotal', Number(e.target.value))}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="sniper-rule-entry" className={LABEL}>
                Entry
              </label>
              <select
                id="sniper-rule-entry"
                value={values.entryStyle}
                onChange={(e) => set('entryStyle', e.target.value as FormState['entryStyle'])}
                className={FIELD}
              >
                <option value="single">single</option>
                <option value="ladder">ladder</option>
              </select>
            </div>
          </div>
          {values.entryStyle === 'ladder' && (
            <div>
              <label htmlFor="sniper-rule-ladder" className={LABEL}>
                Ladder weights (must sum to 1)
              </label>
              <input
                id="sniper-rule-ladder"
                type="text"
                value={values.ladderSplitText}
                onChange={(e) => set('ladderSplitText', e.target.value)}
                placeholder="0.5, 0.3, 0.2"
                className={FIELD}
              />
            </div>
          )}
          <p className={HINT}>
            Size is spend <strong>per wallet</strong>. With {draft.walletIds.length || 0} wallet
            {draft.walletIds.length === 1 ? '' : 's'} selected this rule fires {legCount} leg
            {legCount === 1 ? '' : 's'} and costs{' '}
            <span className="type-data text-oct-text">
              {triggerTotal.toLocaleString(undefined, { maximumFractionDigits: 6 })} {values.sizeUnit}
            </span>{' '}
            including fees.
          </p>
          {/* A cap breach is `critical`, not the accent: it is the one thing on
              this form that guarantees a refusal. */}
          {overTriggerCap && (
            <p className="type-caption font-mono font-normal text-oct-critical bg-oct-critical-dim border border-oct-critical/50 rounded-oct px-comfy py-cozy leading-relaxed">
              This rule can never fire: the trigger total exceeds its own per-trigger cap ({draft.perTriggerCap}). Arming
              will be refused with size_over_trigger_cap.
            </p>
          )}
        </div>

        {/* Wallets ---------------------------------------------------------- */}
        <div className="space-y-cozy">
          <p className={SECTION}>Wallets</p>
          {wallets.length === 0 ? (
            <p className="type-body text-oct-muted">
              No sniper wallets yet. Add one on the Wallets tab — a rule can be saved without wallets, but arming needs
              at least one.
            </p>
          ) : (
            <div className="flex flex-wrap gap-cozy">
              {wallets.map((w) => (
                <button
                  key={w.walletId}
                  type="button"
                  onClick={() => toggleWallet(w.walletId)}
                  className={`px-comfy py-cozy rounded-oct-sm type-label font-mono uppercase border transition-all ${
                    values.walletIds.includes(w.walletId)
                      ? 'border-oct-accent/50 bg-oct-accent text-white shadow-oct-glow-accent'
                      : 'border-oct-border text-oct-muted hover:border-oct-border-bright hover:text-oct-text'
                  }`}
                >
                  {w.label || w.walletId.slice(0, 8)} · {w.unit}
                </button>
              ))}
            </div>
          )}
          {/*
            Saving with no wallet is allowed on purpose — you can draft a rule
            before the wallets exist. But arming then refuses with
            `no_wallets`, and nothing here said so, which made the arm button
            look broken rather than the rule look incomplete.
          */}
          {wallets.length > 0 && values.walletIds.length === 0 && (
            <p className="mt-cozy type-body text-oct-warn leading-relaxed">
              No wallet selected. The rule will save as a draft, but it cannot be armed or fired until you pick one.
            </p>
          )}
        </div>

        {/* Caps ------------------------------------------------------------- */}
        <div className="space-y-comfy">
          <p className={SECTION}>Caps</p>
          <div className="grid grid-cols-2 gap-comfy">
            <div>
              <label htmlFor="sniper-rule-perfire" className={LABEL}>
                Per-fire cap (one leg)
              </label>
              <input
                id="sniper-rule-perfire"
                type="number"
                step="any"
                min="0"
                value={values.perFireCap}
                onChange={(e) => set('perFireCap', Number(e.target.value))}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="sniper-rule-pertrigger" className={LABEL}>
                Per-trigger cap (all legs)
              </label>
              <input
                id="sniper-rule-pertrigger"
                type="number"
                step="any"
                min="0"
                value={values.perTriggerCap}
                onChange={(e) => set('perTriggerCap', Number(e.target.value))}
                className={FIELD}
              />
            </div>
          </div>
          <div>
            <label htmlFor="sniper-rule-mcap" className={LABEL}>
              Market-cap ceiling <span className="normal-case text-oct-muted/70">(optional)</span>
            </label>
            <input
              id="sniper-rule-mcap"
              type="number"
              step="any"
              min="0"
              value={values.mcapCeiling}
              onChange={(e) => set('mcapCeiling', e.target.value)}
              placeholder="No ceiling"
              className={FIELD}
            />
            <p className={`mt-tight ${HINT}`}>
              Only checked against a market cap already pushed to the console — it is never fetched inline, because a
              fetch in the fire path is latency the buy cannot afford.
            </p>
          </div>
        </div>

        {/* Execution -------------------------------------------------------- */}
        <div className="space-y-comfy">
          <p className={SECTION}>Execution</p>
          <div className="grid grid-cols-3 gap-comfy">
            <div>
              <label htmlFor="sniper-rule-slippage" className={LABEL}>
                Slippage (bps)
              </label>
              <input
                id="sniper-rule-slippage"
                type="number"
                step="1"
                min="1"
                max="10000"
                value={values.slippageBps}
                onChange={(e) => set('slippageBps', Number(e.target.value))}
                className={FIELD}
              />
              {/*
                Slotshark's own dashboard labels this field "SLIPPAGE (%)" and
                wants 50 where we want 5000. Someone reading across the two
                UIs will type the other one's number, so show the percent this
                actually means rather than making them divide by 100.
              */}
              <p className={`mt-tight ${HINT}`}>
                = <span className="type-data">{+(values.slippageBps / 100).toFixed(2)}%</span> tolerance
              </p>
            </div>
            <div>
              <label htmlFor="sniper-rule-tip" className={LABEL}>
                Tip (SOL)
              </label>
              <input
                id="sniper-rule-tip"
                type="number"
                step="any"
                min="0"
                value={values.tip}
                onChange={(e) => set('tip', e.target.value)}
                placeholder={`inherit ${fees.tip}`}
                className={FIELD}
              />
              {/* Blank does NOT mean zero. It means this rule sets nothing and
                  the account-level fee applies — the same precedence the server
                  uses when it computes what to reserve. */}
              <p className={`mt-tight ${HINT}`}>
                Blank inherits the account setting (<span className="type-data">{fees.tip}</span>).
              </p>
            </div>
            <div>
              <label htmlFor="sniper-rule-priority" className={LABEL}>
                Priority fee (SOL)
              </label>
              <input
                id="sniper-rule-priority"
                type="number"
                step="any"
                min="0"
                value={values.priorityFee}
                onChange={(e) => set('priorityFee', e.target.value)}
                placeholder={`inherit ${fees.priorityFee}`}
                className={FIELD}
              />
              <p className={`mt-tight ${HINT}`}>
                Blank inherits the account setting (<span className="type-data">{fees.priorityFee}</span>).
              </p>
            </div>
          </div>
          <Toggle value={values.antimev} onChange={(v) => set('antimev', v)} label="Anti-MEV (the venue picks the relay)" />
        </div>

        {/* Timing ----------------------------------------------------------- */}
        <div className="space-y-comfy">
          <p className={SECTION}>Timing</p>
          <div className="grid grid-cols-2 gap-comfy">
            <div>
              <label htmlFor="sniper-rule-window" className={LABEL}>
                Fire window (ms)
              </label>
              <input
                id="sniper-rule-window"
                type="number"
                step="1000"
                min="1"
                value={values.fireWindowMs}
                onChange={(e) => set('fireWindowMs', Number(e.target.value))}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="sniper-rule-attempts" className={LABEL}>
                Max attempts
              </label>
              <input
                id="sniper-rule-attempts"
                type="number"
                step="1"
                min="1"
                max="10"
                value={values.maxAttempts}
                onChange={(e) => set('maxAttempts', Number(e.target.value))}
                className={FIELD}
              />
            </div>
          </div>
          <Toggle
            value={values.autoDisableAfterFire}
            onChange={(v) => set('autoDisableAfterFire', v)}
            label="Disable this rule automatically after it moves money"
          />
        </div>

        {/* Trigger — stored, not wired ------------------------------------- */}
        <fieldset
          disabled
          className="space-y-comfy rounded-oct border border-oct-border bg-oct-bg/60 p-comfy opacity-70"
        >
          <legend className="px-tight type-caption font-mono font-bold uppercase tracking-widest text-oct-warn">
            Trigger — stored, not wired (M2)
          </legend>
          <p className={HINT}>
            Nothing in OCT reads these yet. They exist so a rule written today still means the same thing when the
            tweet feed lands.
          </p>
          <div>
            <label htmlFor="sniper-rule-handles" className={LABEL}>
              Handles
            </label>
            <input
              id="sniper-rule-handles"
              type="text"
              value={values.handlesText}
              onChange={(e) => set('handlesText', e.target.value)}
              placeholder="@someone, @someoneelse"
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="sniper-rule-keywords" className={LABEL}>
              Match any of
            </label>
            <input
              id="sniper-rule-keywords"
              type="text"
              value={values.keywordsText}
              onChange={(e) => set('keywordsText', e.target.value)}
              placeholder="launch, live, sending"
              className={FIELD}
            />
          </div>
        </fieldset>

        {fieldError && (
          <p
            role="alert"
            className="type-body font-mono text-oct-critical bg-oct-critical-dim border border-oct-critical/50 rounded-oct px-comfy py-cozy"
          >
            {fieldError}
          </p>
        )}

        <div className="flex justify-end gap-cozy pt-tight">
          <button type="button" onClick={onClose} disabled={submitting} className="oct-icon-btn px-roomy py-cozy type-body">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="oct-btn-primary px-roomy py-cozy type-body">
            {submitting ? 'Saving…' : mode === 'add' ? 'Save draft' : 'Save changes'}
          </button>
        </div>
      </form>
    </SniperModalShell>
  );
}
