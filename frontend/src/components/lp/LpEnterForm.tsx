import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Loader, Plus, X } from 'lucide-react';
import LpSegmentedField from './LpSegmentedField';
import LpInfoTip from './LpInfoTip';
import { formatFeeTier, shortAddress } from './format';
import {
  LP_BTN_GHOST,
  LP_BTN_PRIMARY,
  LP_EYEBROW,
  LP_HELP,
  LP_INPUT,
  LP_PANEL_TITLE,
} from './styles';
import {
  DEFAULT_SWAP_SLIPPAGE,
  MAX_SWAP_SLIPPAGE,
  enterIssuesByField,
  findEnterPool,
  validateEnterForm,
  type LpEnterFormValues,
  type LpEnterPool,
  type LpEnterRequest,
} from './enter';
import { RANGE_STRATEGIES } from './policyDraft';
import type { RangeStrategy } from './types';
import { useLpEnter } from '../../hooks/useLpEnter';

/**
 * Add liquidity / Zap In — open a NEW LP position from OCT.
 *
 * THIS FORM DOES NOT SIGN OR BROADCAST. Submit writes a row to the same command
 * queue the manual actions use; a separate worker process claims it seconds
 * later and only then builds a transaction. Every piece of copy below names a
 * QUEUE STATE, never a past-tense on-chain outcome — see `LpPositionActions`.
 *
 * Pool options are the SAVED allowlist only (the backend 409s on anything else),
 * restricted to pools whose token metadata is known — see `buildEnterPools`.
 */

const RANGE_HELP: Record<RangeStrategy, string> = {
  narrow: 'Tightest band — earns the most fees per dollar, and rebalances most often.',
  wide: 'A broader band — fewer rebalances, lower fee density.',
  full: 'Whole-range, v2-style — never rebalances, earns the least.',
};

const RANGE_OPTIONS = RANGE_STRATEGIES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

const MECHANISM_TIP =
  'Submit inserts an "enter" row in the LP command queue. The signer worker polls the queue, reads the pool’s live on-chain tick, builds the swap-and-mint transaction and broadcasts it from the automation wallet. Nothing is signed in this browser, and no Safe pending transaction is created.';

export interface LpEnterFormProps {
  pools: LpEnterPool[];
  defaultRangeStrategy: RangeStrategy;
  /** Enter is only writable when the positions API is configured and reachable. */
  enabled: boolean;
  onClose: () => void;
  /** Re-read positions after a successful queue. */
  onSubmitted: () => void;
  /** Switch to the Pools tab to allowlist a pool. */
  onOpenPools: () => void;
}

export default function LpEnterForm({
  pools,
  defaultRangeStrategy,
  enabled,
  onClose,
  onSubmitted,
  onOpenPools,
}: LpEnterFormProps) {
  const [values, setValues] = useState<LpEnterFormValues>(() => ({
    poolAddress: pools.length === 1 ? pools[0]!.address : '',
    tokenInAddress: pools.length === 1 ? pools[0]!.token0.address : '',
    amount: '',
    rangeStrategy: defaultRangeStrategy,
    slippagePercent: String(DEFAULT_SWAP_SLIPPAGE * 100),
  }));
  const [phase, setPhase] = useState<'form' | 'review'>('form');
  const [clientIssues, setClientIssues] = useState(enterIssuesByField([]));
  const [request, setRequest] = useState<LpEnterRequest | null>(null);
  const [done, setDone] = useState(false);

  const enter = useLpEnter({ onSuccess: onSubmitted });

  const selectedPool = useMemo(
    () => findEnterPool(pools, values.poolAddress),
    [pools, values.poolAddress],
  );

  // Escape closes — matches the drawer/detail dismissal elsewhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = (patch: Partial<LpEnterFormValues>) => {
    setValues((prev) => ({ ...prev, ...patch }));
    if (Object.keys(clientIssues).length > 0) setClientIssues(enterIssuesByField([]));
    if (enter.issues.length > 0 || enter.error || enter.conflict) enter.reset();
  };

  const onSelectPool = (poolAddress: string) => {
    const pool = findEnterPool(pools, poolAddress);
    // Default the deposit token to token0 so the choice is always valid.
    update({ poolAddress, tokenInAddress: pool ? pool.token0.address : '' });
  };

  // Server field errors win over the client mirror, as on the policy editor.
  const fieldErrors = useMemo(
    () => ({ ...clientIssues, ...enterIssuesByField(enter.issues) }),
    [clientIssues, enter.issues],
  );

  const tokenOptions = useMemo(() => {
    if (!selectedPool) return [];
    return [
      { value: selectedPool.token0.address, label: selectedPool.token0.symbol },
      { value: selectedPool.token1.address, label: selectedPool.token1.symbol },
    ];
  }, [selectedPool]);

  const selectedToken = useMemo(() => {
    if (!selectedPool) return null;
    if (selectedPool.token0.address === values.tokenInAddress) return selectedPool.token0;
    if (selectedPool.token1.address === values.tokenInAddress) return selectedPool.token1;
    return null;
  }, [selectedPool, values.tokenInAddress]);

  const goReview = () => {
    const result = validateEnterForm(values, selectedPool);
    if (result.issues.length > 0 || !result.request) {
      setClientIssues(enterIssuesByField(result.issues));
      return;
    }
    setClientIssues(enterIssuesByField([]));
    setRequest(result.request);
    setPhase('review');
  };

  const confirm = async () => {
    if (!request) return;
    const result = await enter.submit(request);
    if (result.ok) setDone(true);
    else setPhase('form'); // Bring server-side field/conflict errors back to the inputs.
  };

  const hasPools = pools.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Add liquidity"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg my-auto border-2 border-oct-accent bg-oct-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-4 py-3 border-b-2 border-oct-border bg-oct-surface-raised flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`${LP_EYEBROW} text-oct-accent`}>[ ADD LIQUIDITY ]</p>
            <h3 className={LP_PANEL_TITLE}>Zap in — open a new position</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-oct-muted hover:text-oct-text transition-colors shrink-0"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {!hasPools ? (
            <div className="border-2 border-oct-yellow bg-oct-surface-raised px-4 py-3 space-y-2">
              <p className="font-mono text-xs text-oct-text leading-relaxed">
                No allowlisted pool is available to enter. The worker only opens positions in pools on
                the saved allowlist — and only pools whose token details are known can be sized here.
              </p>
              <button
                type="button"
                onClick={onOpenPools}
                className="font-mono text-[11px] uppercase tracking-[0.12em] text-oct-accent underline hover:no-underline"
              >
                Allowlist a pool in the Pools tab →
              </button>
            </div>
          ) : done ? (
            <div className="space-y-3">
              <div className="border-2 border-oct-green bg-oct-surface-raised px-4 py-3 flex items-start gap-2">
                <Check size={16} strokeWidth={2.5} className="text-oct-green shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-oct-green font-semibold">
                    Entry queued
                  </p>
                  <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1">
                    Written to the command queue. The worker picks it up within a few seconds; nothing has
                    been sent on-chain yet. It appears in the History tab, and the new position shows in
                    Positions once the worker executes it.
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={onClose} className={LP_BTN_PRIMARY}>
                  Done
                </button>
              </div>
            </div>
          ) : phase === 'review' && request ? (
            <ReviewStep
              request={request}
              pool={selectedPool}
              token={selectedToken}
              amount={values.amount}
              submitting={enter.submitting}
              error={enter.error}
              conflict={enter.conflict}
              onBack={() => setPhase('form')}
              onConfirm={() => void confirm()}
            />
          ) : (
            <div className="space-y-4">
              {enter.conflict && (
                <p className="font-mono text-[11px] text-oct-flame leading-relaxed border-2 border-oct-flame bg-oct-surface-raised px-3 py-2">
                  The server refused this: {enter.conflict} Nothing was queued.
                </p>
              )}
              {enter.error && !enter.unavailable && (
                <p className="font-mono text-[11px] text-oct-flame leading-relaxed border-2 border-oct-flame bg-oct-surface-raised px-3 py-2">
                  {enter.error}
                </p>
              )}

              {/* Pool */}
              <div>
                <label className="font-mono text-[11px] uppercase tracking-[0.1em] text-oct-text font-semibold block mb-1.5">
                  Pool
                </label>
                <select
                  className={LP_INPUT}
                  value={values.poolAddress}
                  onChange={(event) => onSelectPool(event.target.value)}
                >
                  <option value="">Select a pool…</option>
                  {pools.map((pool) => (
                    <option key={pool.address} value={pool.address}>
                      {pool.pairLabel}
                      {pool.feeTierBps !== null ? ` · ${formatFeeTier(pool.feeTierBps)}` : ''}
                      {pool.held ? ' · held' : ''}
                    </option>
                  ))}
                </select>
                {selectedPool && (
                  <p className={`${LP_HELP} mt-1.5`}>
                    {shortAddress(selectedPool.address)} — allowlisted. Only saved-allowlist pools can be
                    entered.
                  </p>
                )}
                <FieldError message={fieldErrors.poolAddress} />
              </div>

              {/* Token in */}
              {selectedPool && (
                <LpSegmentedField
                  label="Deposit token"
                  field="tokenInAddress"
                  value={values.tokenInAddress}
                  onChange={(tokenInAddress) => update({ tokenInAddress })}
                  options={tokenOptions}
                  help="The single token you deposit. The worker swaps part of it to add balanced liquidity (zap in)."
                  error={fieldErrors.tokenInAddress}
                />
              )}

              {/* Amount */}
              <div>
                <label className="font-mono text-[11px] uppercase tracking-[0.1em] text-oct-text font-semibold block mb-1.5">
                  Amount
                </label>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    className={LP_INPUT}
                    placeholder="0.0"
                    value={values.amount}
                    onChange={(event) => update({ amount: event.target.value })}
                  />
                  {selectedToken && (
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-oct-muted">
                      {selectedToken.symbol}
                    </span>
                  )}
                </div>
                <p className={`${LP_HELP} mt-1.5`}>
                  {selectedToken
                    ? `In ${selectedToken.symbol}. Converted to base units (${selectedToken.decimals} decimals) before it is queued.`
                    : 'Pick a deposit token to size the amount.'}
                </p>
                <FieldError message={fieldErrors.amount} />
              </div>

              {/* Range */}
              <LpSegmentedField
                label="Range"
                field="rangeStrategy"
                value={values.rangeStrategy}
                onChange={(rangeStrategy) => update({ rangeStrategy })}
                options={RANGE_OPTIONS}
                help={RANGE_HELP[values.rangeStrategy]}
                defaultHint={`policy default ${defaultRangeStrategy}`}
                error={fieldErrors.rangeStrategy}
              />

              {/* Slippage */}
              <div>
                <label className="font-mono text-[11px] uppercase tracking-[0.1em] text-oct-text font-semibold block mb-1.5">
                  Swap slippage
                </label>
                <div className="relative w-32">
                  <input
                    type="text"
                    inputMode="decimal"
                    className={LP_INPUT}
                    placeholder="0.5"
                    value={values.slippagePercent}
                    onChange={(event) => update({ slippagePercent: event.target.value })}
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-oct-muted">
                    %
                  </span>
                </div>
                <p className={`${LP_HELP} mt-1.5`}>
                  Max tolerated price move on the zap swap. Default {DEFAULT_SWAP_SLIPPAGE * 100}%, capped at{' '}
                  {MAX_SWAP_SLIPPAGE * 100}%.
                </p>
                <FieldError message={fieldErrors.swapSlippage} />
              </div>

              <div className="border-t-2 border-oct-border pt-3 space-y-3">
                <p className="font-mono text-[11px] text-oct-muted leading-relaxed inline-flex items-start gap-1.5">
                  <span>
                    This queues a transaction for the automation signer — it does not open a Safe pending
                    transaction.
                  </span>
                  <LpInfoTip text={MECHANISM_TIP} label="How an entry is executed" />
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={onClose} className={LP_BTN_GHOST}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={goReview}
                    disabled={!enabled}
                    className={LP_BTN_PRIMARY}
                    title={enabled ? undefined : 'The positions API is not reachable.'}
                  >
                    <Plus size={12} strokeWidth={2.5} />
                    Review
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-1.5 flex items-start gap-1.5 font-mono text-[11px] text-oct-flame leading-snug">
      <AlertTriangle size={12} className="shrink-0 mt-0.5" />
      <span>{message}</span>
    </p>
  );
}

function ReviewStep({
  request,
  pool,
  token,
  amount,
  submitting,
  error,
  conflict,
  onBack,
  onConfirm,
}: {
  request: LpEnterRequest;
  pool: LpEnterPool | null;
  token: { symbol: string; decimals: number } | null;
  amount: string;
  submitting: boolean;
  error: string | null;
  conflict: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="font-mono text-[11px] text-oct-muted leading-relaxed">
        Review before it is queued. The range is centered on the pool’s live on-chain tick at execution
        time, so the exact bounds are set by the worker, not here.
      </p>

      <dl className="border-2 border-oct-border divide-y-2 divide-oct-border">
        <Row label="Pool" value={pool ? pool.pairLabel : shortAddress(request.poolAddress)} />
        <Row
          label="Deposit"
          value={`${amount.trim()} ${token?.symbol ?? ''}`.trim()}
          sub={`${request.amountIn} base units${token ? ` · ${token.decimals} decimals` : ''}`}
        />
        <Row label="Range" value={request.rangeStrategy} />
        <Row label="Slippage" value={`${request.swapSlippage * 100}%`} />
      </dl>

      {conflict && (
        <p className="font-mono text-[11px] text-oct-flame leading-relaxed border-2 border-oct-flame bg-oct-surface-raised px-3 py-2">
          The server refused this: {conflict} Nothing was queued.
        </p>
      )}
      {error && (
        <p className="font-mono text-[11px] text-oct-flame leading-relaxed border-2 border-oct-flame bg-oct-surface-raised px-3 py-2">
          {error}
        </p>
      )}

      <p className="font-mono text-[11px] text-oct-muted leading-relaxed inline-flex items-start gap-1.5">
        <span>
          This queues a transaction for the automation signer — it does not open a Safe pending
          transaction.
        </span>
        <LpInfoTip text={MECHANISM_TIP} label="How an entry is executed" />
      </p>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onBack} disabled={submitting} className={LP_BTN_GHOST}>
          <ArrowLeft size={12} strokeWidth={2.5} />
          Back
        </button>
        <button type="button" onClick={onConfirm} disabled={submitting} className={LP_BTN_PRIMARY}>
          {submitting ? (
            <Loader size={12} strokeWidth={2.5} className="animate-spin" />
          ) : (
            <Plus size={12} strokeWidth={2.5} />
          )}
          {submitting ? 'Queueing…' : 'Confirm & queue'}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted shrink-0 pt-0.5">
        {label}
      </dt>
      <dd className="min-w-0 text-right">
        <p className="font-mono text-sm text-oct-text tabular-nums break-all">{value || '—'}</p>
        {sub && <p className="font-mono text-[10px] text-oct-muted break-all mt-0.5">{sub}</p>}
      </dd>
    </div>
  );
}
