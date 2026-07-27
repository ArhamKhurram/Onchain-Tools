import { useMemo, useState } from 'react';
import { Check, Loader, Plus } from 'lucide-react';
import { normalizeAddress } from './selection';
import { LP_BTN, LP_BTN_PRIMARY, LP_HELP, LP_INPUT } from './styles';
import {
  DEFAULT_SWAP_SLIPPAGE,
  increaseDepositTokenOptions,
  increaseIssuesByField,
  validateIncreaseForm,
  type LpIncreaseFormValues,
  type LpIncreaseRequest,
} from './increase';
import type { LpPositionView } from './positions';
import { useLpIncrease } from '../../hooks/useLpIncrease';

export interface LpIncreaseFormProps {
  position: LpPositionView;
  enabled: boolean;
  /** Another command is already in flight for this position. */
  blocked: boolean;
  blockedReason?: string | null;
  onSubmitted: () => void;
}

export default function LpIncreaseForm({
  position,
  enabled,
  blocked,
  blockedReason,
  onSubmitted,
}: LpIncreaseFormProps) {
  const token0 = position.token0;
  const token1 = position.token1;
  const defaultToken = token0?.address ?? '';

  const [values, setValues] = useState<LpIncreaseFormValues>(() => ({
    tokenInAddress: defaultToken,
    amount: '',
    slippagePercent: String(DEFAULT_SWAP_SLIPPAGE * 100),
  }));
  const [clientIssues, setClientIssues] = useState(increaseIssuesByField([]));
  const [done, setDone] = useState(false);

  const increase = useLpIncrease({ onSuccess: onSubmitted });

  const tokens = useMemo(() => increaseDepositTokenOptions(position), [position]);

  const fieldErrors = useMemo(
    () => ({ ...clientIssues, ...increaseIssuesByField(increase.issues) }),
    [clientIssues, increase.issues],
  );

  const disabled = !enabled || blocked || increase.submitting || increase.unavailable;

  const queueIncrease = async (request: LpIncreaseRequest) => {
    const result = await increase.submit(position.tokenId, request);
    if (result.ok) {
      setDone(true);
      setValues((prev) => ({ ...prev, amount: '' }));
    }
  };

  const onSubmit = () => {
    setDone(false);
    const { issues, request } = validateIncreaseForm(values, position);
    setClientIssues(increaseIssuesByField(issues));
    if (!request) return;
    void queueIncrease(request);
  };

  if (done && increase.lastCommand?.status === 'pending') {
    return (
      <div className="border-2 border-oct-yellow bg-oct-surface-raised px-3 py-2 flex items-center gap-2">
        <Check size={13} className="text-oct-yellow shrink-0" />
        <p className="font-mono text-[11px] text-oct-yellow">
          Add liquidity queued — the worker will approve WETH if needed (or send native ETH), then zap in. Nothing signed in this browser.
        </p>
      </div>
    );
  }

  return (
    <div className="border-2 border-oct-border bg-oct-surface-raised px-3 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <Plus size={13} className="text-oct-accent shrink-0" />
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-oct-text">Add liquidity</p>
      </div>
      <p className={LP_HELP}>
        Queues a zap-increase through the automation worker — same path as compound/rebalance. Choose WETH
        (requires a one-time approve) or native ETH (worker sends value via the module cap).
      </p>

      {blocked && blockedReason && (
        <p className="font-mono text-[11px] text-oct-yellow">{blockedReason}</p>
      )}
      {increase.conflict && (
        <p className="font-mono text-[11px] text-oct-yellow">{increase.conflict}</p>
      )}
      {increase.error && (
        <p className="font-mono text-[11px] text-oct-flame">{increase.error}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {tokens.map((token) => {
          const selected = normalizeAddress(values.tokenInAddress) === normalizeAddress(token.value);
          return (
            <button
              key={token.value}
              type="button"
              disabled={disabled}
              onClick={() => setValues((prev) => ({ ...prev, tokenInAddress: token.value }))}
              className={`${LP_BTN} px-2 py-1 text-[10px] ${
                selected
                  ? 'border-oct-accent text-oct-accent bg-oct-accent-dim'
                  : 'border-oct-border-bright text-oct-muted'
              }`}
            >
              {token.label || shortAddr(token.value)}
            </button>
          );
        })}
      </div>
      {fieldErrors.tokenInAddress && (
        <p className="font-mono text-[10px] text-oct-flame">{fieldErrors.tokenInAddress}</p>
      )}

      <div>
        <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted">Amount</label>
        <input
          type="text"
          inputMode="decimal"
          disabled={disabled}
          value={values.amount}
          onChange={(e) => setValues((prev) => ({ ...prev, amount: e.target.value }))}
          className={`${LP_INPUT} mt-1 w-full`}
          placeholder="0.0"
        />
        {fieldErrors.amount && (
          <p className="font-mono text-[10px] text-oct-flame mt-1">{fieldErrors.amount}</p>
        )}
      </div>

      <div>
        <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted">
          Swap slippage (%)
        </label>
        <input
          type="text"
          inputMode="decimal"
          disabled={disabled}
          value={values.slippagePercent}
          onChange={(e) => setValues((prev) => ({ ...prev, slippagePercent: e.target.value }))}
          className={`${LP_INPUT} mt-1 w-24`}
        />
        {fieldErrors.swapSlippage && (
          <p className="font-mono text-[10px] text-oct-flame mt-1">{fieldErrors.swapSlippage}</p>
        )}
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={onSubmit}
        className={`${LP_BTN_PRIMARY} w-full sm:w-auto`}
      >
        {increase.submitting ? (
          <>
            <Loader size={13} className="animate-spin" />
            Queueing…
          </>
        ) : (
          'Queue add liquidity'
        )}
      </button>
    </div>
  );
}

function shortAddr(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
